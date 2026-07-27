"""Guards around the natural-language query path.

Two independent jobs:

``scrub`` / ``rehydrate``
    The schema never leaves the jurisdiction as data, but the *question* can:
    "show me the status of crime number 100051428201600001" carries an
    identifier straight to a third party. Rather than reject those questions,
    the identifiers are replaced with opaque placeholders before the question is
    sent, and substituted back into the generated query locally. The model sees
    ``<ID_1>`` and writes ``WHERE crime_no = '<ID_1>'``; the real value is put
    back here, so the query still works and the identifier never crossed the
    boundary.

``validate_query``
    Everything the prompt asks for, re-checked as a hard rule. A prompt is a
    request; this is the guarantee. Read-only, allowlisted tables and columns,
    no protected attributes, no FIR narrative, bounded row count.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.nl_schema import (
    BLOCKED_COLUMNS,
    BLOCKED_TABLES,
    allowed_columns,
    allowed_tables,
)

MAX_ROWS = 500

# Identifiers worth scrubbing from an outbound question: crime numbers (18 digits),
# KGID (7-8), case numbers (9), plus contact details that should never be in a query.
_ID_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b[A-Za-z]{0,4}\d{6,}\b"),  # long numeric / prefixed ids
    re.compile(r"\b[\w.%-]+@[\w.-]+\.[A-Za-z]{2,}\b"),  # email
    re.compile(r"\b(?:\+91[- ]?)?[6-9]\d{9}\b"),  # Indian mobile
)

_WRITE_KEYWORDS = (
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "replace",
    "grant",
    "revoke",
    "attach",
    "pragma",
    "vacuum",
    "copy",
    "merge",
    "call",
    "execute",
)

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_FROM_JOIN = re.compile(r"\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
_LIMIT = re.compile(r"\blimit\s+(\d+)", re.IGNORECASE)


class QueryRejected(ValueError):
    """Raised when a generated query fails validation. The query is never executed."""


@dataclass
class Scrubbed:
    text: str
    mapping: dict[str, str]

    @property
    def redacted_count(self) -> int:
        return len(self.mapping)


def scrub(question: str) -> Scrubbed:
    """Replace identifiers in a question with placeholders before it leaves the network."""
    mapping: dict[str, str] = {}
    counter = 0

    def _replace(match: re.Match[str]) -> str:
        nonlocal counter
        value = match.group(0)
        for placeholder, original in mapping.items():
            if original == value:
                return placeholder
        counter += 1
        placeholder = f"<ID_{counter}>"
        mapping[placeholder] = value
        return placeholder

    text = question
    for pattern in _ID_PATTERNS:
        text = pattern.sub(_replace, text)
    return Scrubbed(text=text, mapping=mapping)


def rehydrate(query: str, mapping: dict[str, str]) -> str:
    """Put the real identifiers back into the generated query, locally."""
    for placeholder, original in mapping.items():
        query = query.replace(placeholder, original)
    return query


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql


def validate_query(sql: str, source: str) -> str:
    """Validate a generated query and return it normalised, or raise QueryRejected.

    Rejects on the first violation rather than trying to repair the query — a
    query that needed repairing is one the model did not mean.
    """
    if not sql or not sql.strip():
        raise QueryRejected("The model returned an empty query.")

    cleaned = _strip_comments(sql).strip().rstrip(";").strip()
    if not cleaned:
        raise QueryRejected("The query was only comments.")

    if ";" in cleaned:
        raise QueryRejected("Multiple statements are not allowed.")

    lowered = cleaned.lower()
    if not lowered.startswith("select"):
        raise QueryRejected("Only SELECT queries are allowed.")

    words = {w.lower() for w in _IDENT.findall(cleaned)}

    banned = words & set(_WRITE_KEYWORDS)
    if banned:
        raise QueryRejected(f"Query contains a write or DDL keyword: {', '.join(sorted(banned))}.")

    blocked_cols = words & BLOCKED_COLUMNS
    if blocked_cols:
        raise QueryRejected(
            f"Query references a protected column: {', '.join(sorted(blocked_cols))}. "
            "FIR narrative text and protected attributes cannot be queried through this endpoint."
        )

    referenced = {m.lower() for m in _FROM_JOIN.findall(cleaned)}

    blocked_ref = referenced & BLOCKED_TABLES
    if blocked_ref:
        names = ", ".join(sorted(blocked_ref))
        if blocked_ref == {"audit_log"}:
            reason = "The audit log records who asked what; it is not queryable through the assistant."
        else:
            reason = (
                "Caste, religion, and occupation are protected attributes under §2.0 "
                "and are not queryable."
            )
        raise QueryRejected(f"Query references a protected table: {names}. {reason}")

    permitted = allowed_tables(source)
    unknown = referenced - permitted
    if unknown:
        raise QueryRejected(
            f"Query references unknown table(s): {', '.join(sorted(unknown))}. "
            f"Available tables: {', '.join(sorted(permitted))}."
        )
    if not referenced:
        raise QueryRejected("Query does not read from any table.")

    # Column check is advisory — a bare identifier may be an alias or a function
    # name, so only flag identifiers that look like a qualified column reference.
    permitted_cols = allowed_columns(source)
    for qualified in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)", cleaned):
        _, col = qualified
        if col.lower() in BLOCKED_COLUMNS:
            raise QueryRejected(f"Query references a protected column: {col}.")
        if col != "*" and col.lower() not in permitted_cols:
            raise QueryRejected(
                f"Query references unknown column {col!r}. Only catalogued columns can be selected."
            )

    match = _LIMIT.search(cleaned)
    if match:
        if int(match.group(1)) > MAX_ROWS:
            cleaned = _LIMIT.sub(f"LIMIT {MAX_ROWS}", cleaned, count=1)
    else:
        cleaned = f"{cleaned} LIMIT {MAX_ROWS}"

    return cleaned


_AGGREGATES = re.compile(r"\b(count|sum|avg|min|max|group_concat|total)\s*\(", re.IGNORECASE)
_SELECT_LIST = re.compile(r"^select\s+(?:distinct\s+)?(.*?)\s+from\b", re.IGNORECASE | re.DOTALL)
_FIRST_FROM = re.compile(r"\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?", re.IGNORECASE)
_INNER_JOIN = re.compile(r"(?<!left\s)(?<!right\s)(?<!full\s)(?<!cross\s)\bjoin\b", re.IGNORECASE)


def is_aggregate(sql: str) -> bool:
    """True when the query summarises rather than enumerates."""
    lowered = sql.lower()
    return bool(_AGGREGATES.search(sql)) or " group by " in lowered


_TABLE_REF = re.compile(
    r"\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?",
    re.IGNORECASE,
)
_JOIN_CLAUSE = re.compile(
    r"\b(left\s+outer|left|right\s+outer|right|full\s+outer|full|cross|inner)?\s*\bjoin\b"
    r"\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?"
    r"\s+on\s+(.*?)(?=\b(?:left|right|full|cross|inner)?\s*\bjoin\b|\bwhere\b|\bgroup\b|\border\b|\blimit\b|$)",
    re.IGNORECASE | re.DOTALL,
)
_RESERVED_ALIASES = {"where", "group", "order", "limit", "join", "left", "right", "full",
                     "cross", "inner", "on", "as", "union", "having"}


def _alias_map(sql: str) -> dict[str, str]:
    """alias (or bare table name) -> table name, so qualified columns resolve."""
    aliases: dict[str, str] = {}
    for table, alias in _TABLE_REF.findall(sql):
        aliases[table.lower()] = table.lower()
        if alias and alias.lower() not in _RESERVED_ALIASES:
            aliases[alias.lower()] = table.lower()
    return aliases


def joins_on_optional(sql: str, source: str) -> list[str]:
    """Optional columns used in an INNER join's ON clause — where rows vanish.

    Prompt rule 6 asks for LEFT JOIN on nullable columns. This reports whether
    the model actually did it, so the answer can be qualified when it did not.

    Precision matters more than recall here: a warning that rows may be missing,
    attached to a query where none are, teaches the user to ignore the warnings.
    So this resolves aliases to tables and only inspects the ON clause of joins
    that are genuinely inner.
    """
    from app.services.nl_schema import optional_columns

    optional = optional_columns(source)
    if not optional:
        return []

    aliases = _alias_map(sql)
    flagged: set[str] = set()

    for kind, on_clause in _JOIN_CLAUSE.findall(sql):
        if kind and kind.strip().lower().split()[0] in {"left", "right", "full", "cross"}:
            continue  # outer join — nulls are preserved, which is the point
        for prefix, col in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)", on_clause):
            table = aliases.get(prefix.lower())
            if table and f"{table}.{col.lower()}" in optional:
                flagged.add(f"{table}.{col.lower()}")

    return sorted(flagged)


def add_identifier(sql: str, source: str) -> tuple[str, str | None]:
    """Add the main table's primary key to the SELECT list if it is missing.

    BACKEND.md makes evidence mandatory, and prompt rule 5 asks for the key —
    but a prompt is a request. This is the guarantee. It only rewrites the
    simple, unambiguous case: a row-level query, no DISTINCT, no set operation,
    no subquery in the select list. Anything cleverer is left alone and reported
    in ``notes`` instead, because silently changing a query the user is about to
    read would be worse than an incomplete evidence list.

    Returns the query and the column added, or None when nothing was changed.
    """
    from app.services.nl_schema import primary_key_for

    if is_aggregate(sql):
        return sql, None

    lowered = sql.lower()
    if any(tok in lowered for tok in (" union ", " intersect ", " except ", "distinct")):
        return sql, None

    select_match = _SELECT_LIST.search(sql)
    from_match = _FIRST_FROM.search(sql)
    if not select_match or not from_match:
        return sql, None

    select_list = select_match.group(1)
    if "(" in select_list:  # a function or subquery — do not touch
        return sql, None

    table, alias = from_match.group(1), from_match.group(2)
    if alias and alias.lower() in {"where", "group", "order", "limit", "join", "left", "inner", "on"}:
        alias = None
    prefix = alias or table

    pk = primary_key_for(source, table)
    if not pk:
        return sql, None

    qualified = f"{prefix}.{pk}"
    already = re.search(rf"(?:^|[\s,]){re.escape(prefix)}\.{re.escape(pk)}\b", select_list, re.IGNORECASE)
    bare = re.search(rf"(?:^|[\s,]){re.escape(pk)}\b", select_list, re.IGNORECASE)
    if already or bare or select_list.strip() == "*":
        return sql, None

    start, end = select_match.span(1)
    return sql[:start] + f"{qualified}, " + sql[start:], qualified
