"""Guard tests for the natural-language assistant.

These are the tests that make the compliance claim in docs/ASSISTANT.md
checkable rather than aspirational. They need no API key, no database and no
network: the scrubber and the validator are pure functions, which is the point
— the boundary that keeps FIR text out of a third-party model does not depend
on the model behaving well.

Run:  python test_ask_guards.py
Exit: 0 all passed, 1 otherwise.

If you add a table or column to nl_schema.py, add a case here. If you find
yourself relaxing a rule to make a query pass, that is the signal to reject the
query instead.
"""

from __future__ import annotations

import sys

from app.services.nl_guard import (
    MAX_ROWS,
    QueryRejected,
    add_identifier,
    joins_on_optional,
    rehydrate,
    scrub,
    validate_query,
)
from app.services.nl_schema import (
    BLOCKED_COLUMNS,
    SOURCE_CATALYST,
    SOURCE_LOCAL,
    render_catalogue,
)

failures: list[str] = []


def _fail(label: str, detail: str) -> None:
    failures.append(label)
    print(f"  FAIL  {label}\n          {detail}")


def rejects(label: str, sql: str, source: str = SOURCE_LOCAL) -> None:
    """The query must never reach the database."""
    try:
        out = validate_query(sql, source)
    except QueryRejected as exc:
        print(f"  ok    rejected: {label}\n          {exc}")
        return
    _fail(label, f"should have been rejected, returned: {out}")


def permits(label: str, sql: str, source: str = SOURCE_LOCAL, contains: str | None = None) -> None:
    try:
        out = validate_query(sql, source)
    except QueryRejected as exc:
        _fail(label, f"should have been permitted, rejected with: {exc}")
        return
    if contains and contains.lower() not in out.lower():
        _fail(label, f"expected {contains!r} in {out!r}")
        return
    print(f"  ok    permitted: {label}")


def test_scrub_roundtrip() -> None:
    print("\n[scrub] identifiers never leave, and come back intact")
    question = "status of crime number 100051428201600001 for officer KGID 1353603?"
    s = scrub(question)
    if "100051428201600001" in s.text or "1353603" in s.text:
        _fail("scrub", f"identifier leaked into outbound text: {s.text}")
        return
    print(f"  ok    outbound text carries no identifier: {s.text}")

    generated = "SELECT id, crime_no FROM case_master WHERE crime_no = '<ID_1>'"
    restored = rehydrate(generated, s.mapping)
    if "100051428201600001" not in restored:
        _fail("rehydrate", f"identifier not restored: {restored}")
        return
    print(f"  ok    restored locally: {restored}")

    # A repeated identifier must map to one placeholder, not two.
    twice = scrub("compare 100051428201600001 with 100051428201600001")
    if len(twice.mapping) != 1:
        _fail("scrub dedupe", f"expected 1 placeholder, got {twice.mapping}")
        return
    print("  ok    repeated identifiers share a placeholder")

    # A question with nothing sensitive must pass through untouched.
    clean = scrub("how many burglaries in Bengaluru City last month?")
    if clean.mapping or clean.text != "how many burglaries in Bengaluru City last month?":
        _fail("scrub passthrough", f"ordinary question was altered: {clean}")
        return
    print("  ok    ordinary questions pass through unchanged")


def test_rejections() -> None:
    print("\n[validator] queries that must never run")
    rejects("write statement", "DELETE FROM case_master")
    rejects("update", "UPDATE case_master SET status = 'Disposed'")
    rejects("DDL", "DROP TABLE district")
    rejects("stacked statements", "SELECT 1 FROM district; DROP TABLE district")
    rejects("write hidden in a subquery", "SELECT id FROM case_master WHERE id IN (UPDATE x SET y=1)")
    rejects("comment-only", "-- nothing to see here")
    rejects("empty", "   ")

    # The §10 boundary: FIR free text.
    rejects("FIR narrative, bare", "SELECT id, narrative FROM case_master")
    rejects("FIR narrative, qualified", "SELECT case_master.narrative FROM case_master")
    rejects("FIR narrative, aliased table", "SELECT c.narrative FROM case_master c")
    rejects("BriefFacts on Catalyst", "SELECT CaseMaster.BriefFacts FROM CaseMaster", SOURCE_CATALYST)

    # The §2.0 boundary: protected attributes.
    rejects("caste lookup", "SELECT c.id FROM caste_master c")
    rejects("religion lookup", "SELECT r.id FROM religion_master r")
    rejects("occupation lookup", "SELECT o.id FROM occupation_master o")
    rejects("caste column", "SELECT person.caste_id FROM person")

    # The audit trail is not itself a queryable surface.
    rejects("audit log", "SELECT * FROM audit_log")

    # Allowlist, not blocklist.
    rejects("unknown table", "SELECT * FROM salaries")
    rejects("unknown column", "SELECT case_master.salary FROM case_master")
    rejects("no table at all", "SELECT 1")


def test_permissions() -> None:
    print("\n[validator] queries that must run")
    permits(
        "district counts",
        "SELECT d.name, COUNT(*) AS total FROM case_master c "
        "JOIN district d ON c.district_id = d.id GROUP BY d.name",
        contains=f"LIMIT {MAX_ROWS}",
    )
    permits(
        "per-100k rate (the §comparability rule)",
        "SELECT d.name, COUNT(c.id) * 100000.0 / d.population AS rate FROM case_master c "
        "JOIN district d ON c.district_id = d.id GROUP BY d.name, d.population LIMIT 40",
    )
    permits(
        "clearance via chargesheet",
        "SELECT d.name, AVG(CASE WHEN cs.filed THEN 1.0 ELSE 0.0 END) AS rate "
        "FROM case_master c JOIN district d ON c.district_id = d.id "
        "JOIN chargesheet_details cs ON cs.case_id = c.id GROUP BY d.name",
    )
    permits(
        "catalyst ZCQL",
        "SELECT CaseMaster.ROWID, CaseMaster.CrimeNo FROM CaseMaster LIMIT 10",
        SOURCE_CATALYST,
    )

    print("\n[validator] row cap is enforced, not requested")
    out = validate_query("SELECT id FROM case_master LIMIT 999999", SOURCE_LOCAL)
    if f"LIMIT {MAX_ROWS}" not in out:
        _fail("limit clamp", f"expected clamp to {MAX_ROWS}, got {out}")
    else:
        print(f"  ok    999999 clamped to {MAX_ROWS}")

    out = validate_query("SELECT id FROM case_master", SOURCE_LOCAL)
    if f"LIMIT {MAX_ROWS}" not in out:
        _fail("limit added", f"expected a LIMIT to be added, got {out}")
    else:
        print(f"  ok    missing LIMIT added: {out}")


def test_catalogue_is_clean() -> None:
    """The model must not even learn that the protected columns exist."""
    print("\n[catalogue] the prompt never mentions a blocked column")
    for source in (SOURCE_LOCAL, SOURCE_CATALYST):
        catalogue = render_catalogue(source).lower()
        leaked = sorted(c for c in BLOCKED_COLUMNS if c in catalogue)
        if leaked:
            _fail(f"catalogue/{source}", f"blocked columns present in prompt: {leaked}")
        else:
            print(f"  ok    {source}: {len(catalogue.splitlines())} lines, none of {len(BLOCKED_COLUMNS)} blocked names")


def test_evidence_is_added() -> None:
    """Evidence is mandatory, so the key is added when the model forgets it."""
    print("\n[evidence] the primary key is added, not merely requested")

    sql, added = add_identifier(
        "SELECT cm.status FROM case_master cm WHERE cm.crime_no = '100010003' LIMIT 500",
        SOURCE_LOCAL,
    )
    if added != "cm.id" or "cm.id" not in sql:
        _fail("add pk", f"expected cm.id to be added, got added={added!r} sql={sql!r}")
    else:
        print(f"  ok    row query gained {added}: {sql}")

    # Already present — must not be duplicated.
    original = "SELECT cm.id, cm.status FROM case_master cm LIMIT 500"
    sql, added = add_identifier(original, SOURCE_LOCAL)
    if added is not None or sql != original:
        _fail("no duplicate pk", f"should have been left alone, got {sql!r}")
    else:
        print("  ok    query that already selects the key is left alone")

    # Aggregates must not gain a bare key beside the aggregate — that is an
    # error on PostgreSQL and returns an arbitrary row on SQLite.
    agg = "SELECT d.name, COUNT(*) AS total FROM case_master cm JOIN district d ON cm.district_id = d.id GROUP BY d.name"
    sql, added = add_identifier(agg, SOURCE_LOCAL)
    if added is not None:
        _fail("aggregate untouched", f"must not add a key to an aggregate, added {added!r}")
    else:
        print("  ok    aggregate left alone")

    for label, query in (
        ("DISTINCT", "SELECT DISTINCT cm.status FROM case_master cm"),
        ("UNION", "SELECT cm.status FROM case_master cm UNION SELECT status FROM case_master"),
        ("function in select list", "SELECT upper(cm.status) FROM case_master cm"),
    ):
        _, added = add_identifier(query, SOURCE_LOCAL)
        if added is not None:
            _fail(f"leave {label} alone", f"rewrote a {label} query, added {added!r}")
        else:
            print(f"  ok    {label} left alone rather than rewritten blindly")


def test_optional_join_detection() -> None:
    """An inner join on a nullable column is why 'no records' can be a lie."""
    print("\n[optional joins] inner joins on nullable columns are detected")

    bad = (
        "SELECT cm.status, e.name FROM case_master cm JOIN employee e ON cm.officer_id = e.id "
        "WHERE cm.crime_no = '100010003'"
    )
    found = joins_on_optional(bad, SOURCE_LOCAL)
    if found != ["case_master.officer_id"]:
        _fail("detect inner join", f"expected ['case_master.officer_id'], got {found}")
    else:
        print(f"  ok    inner JOIN on a nullable column detected: {found}")

    good = bad.replace(" JOIN ", " LEFT JOIN ")
    if joins_on_optional(good, SOURCE_LOCAL):
        _fail("left join ok", "LEFT JOIN should not be flagged")
    else:
        print("  ok    the LEFT JOIN version is not flagged")

    plain = "SELECT cm.id, cm.status FROM case_master cm WHERE cm.status = 'Disposed'"
    if joins_on_optional(plain, SOURCE_LOCAL):
        _fail("no join", "a query with no join should not be flagged")
    else:
        print("  ok    a query with no join is not flagged")

    # The false positive this check was originally written with: case_master.unit_id
    # is NOT nullable, only employee.unit_id is. Matching bare column names
    # warned about the wrong query, which trains people to ignore warnings.
    mixed = (
        "SELECT cm.id, u.name FROM case_master cm JOIN district d ON cm.district_id = d.id "
        "LEFT JOIN unit u ON cm.unit_id = u.id WHERE d.name = 'Kalaburagi'"
    )
    found = joins_on_optional(mixed, SOURCE_LOCAL)
    if found:
        _fail("no false positive", f"case_master.unit_id is not nullable, but got {found}")
    else:
        print("  ok    inner join on a NON-nullable column is not flagged (no false positive)")

    # ... and the same column name really is nullable on the other table.
    emp = "SELECT e.name, u.name FROM employee e JOIN unit u ON e.unit_id = u.id"
    found = joins_on_optional(emp, SOURCE_LOCAL)
    if found != ["employee.unit_id"]:
        _fail("qualified match", f"expected ['employee.unit_id'], got {found}")
    else:
        print(f"  ok    the same column name on the nullable table IS flagged: {found}")


def test_catalogue_marks_optional() -> None:
    """The model can only avoid the trap if the schema tells it where the trap is."""
    print("\n[catalogue] optional columns and keys are marked for the model")
    catalogue = render_catalogue(SOURCE_LOCAL)
    if "OPTIONAL" not in catalogue:
        _fail("optional marker", "catalogue does not mark any column OPTIONAL")
    else:
        marked = [ln.strip() for ln in catalogue.splitlines() if "OPTIONAL" in ln]
        print(f"  ok    {len(marked)} column(s) marked OPTIONAL, e.g. {marked[0][:70]}")
    if "PRIMARY KEY" not in catalogue:
        _fail("pk marker", "catalogue does not mark any PRIMARY KEY")
    else:
        print("  ok    primary keys marked")


def main() -> int:
    test_scrub_roundtrip()
    test_rejections()
    test_permissions()
    test_evidence_is_added()
    test_optional_join_detection()
    test_catalogue_marks_optional()
    test_catalogue_is_clean()

    print()
    if failures:
        print(f"FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("All guard tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
