"""Natural-language question → query → evidence-linked answer.

The order of operations is the whole design:

    scrub identifiers → plan (model sees schema only) → rehydrate → validate
    → execute locally → summarise in code

The model participates in exactly one step, and it is the step that touches no
data. Everything after ``validate`` runs inside the jurisdiction. The prose the
user reads is generated here, deterministically, from the result set — not by
the model, because sending the result set to a model to be narrated is the one
thing this design exists to avoid.

Per BACKEND.md, every answer carries ``evidence``: the record ids the rows came
from. An answer with no traceable rows is not returned as an answer.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.services.catalyst import CatalystError, get_catalyst_client
from app.services.nl_guard import (
    QueryRejected,
    add_identifier,
    integer_division_risk,
    is_aggregate,
    joins_on_optional,
    rehydrate,
    scrub,
    validate_query,
)
from app.services.nl_provider import PlannerUnavailable, QueryPlan, build_planner
from app.services.nl_schema import SOURCE_CATALYST, SOURCE_LOCAL, tables_for

log = logging.getLogger(__name__)

_EVIDENCE_KEYS = ("id", "case_id", "rowid", "ROWID", "crime_no", "CrimeNo")
_MAX_EVIDENCE = 50


@dataclass
class AskResult:
    answer: str
    query: str
    rows: list[dict[str, Any]]
    evidence: list[str]
    columns: list[str]
    source: str
    model: str
    answerable: bool = True
    redacted_identifiers: int = 0
    elapsed_ms: int = 0
    notes: list[str] = field(default_factory=list)


class AskFailed(RuntimeError):
    """Raised when the question cannot be answered. Carries a user-safe message."""

    def __init__(self, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.detail = detail


def _dialect(source: str) -> str:
    return "ZCQL (Zoho Catalyst)" if source == SOURCE_CATALYST else "SQLite/PostgreSQL SQL"


def _execute_local(db: Session, sql: str) -> tuple[list[str], list[dict[str, Any]]]:
    result = db.execute(text(sql))
    columns = list(result.keys())
    rows = [dict(zip(columns, row)) for row in result.fetchall()]
    return columns, rows


def _execute_catalyst(zcql: str) -> tuple[list[str], list[dict[str, Any]]]:
    rows = get_catalyst_client().query(zcql)
    columns = list(rows[0].keys()) if rows else []
    return columns, rows


def _collect_evidence(rows: list[dict[str, Any]]) -> list[str]:
    """Pull record ids out of the result set so every answer is traceable."""
    evidence: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in _EVIDENCE_KEYS:
            if key in row and row[key] is not None:
                value = str(row[key])
                if value not in seen:
                    seen.add(value)
                    evidence.append(value)
                break
        if len(evidence) >= _MAX_EVIDENCE:
            break
    return evidence


def _first_sentence(text: str) -> str:
    """Keep the first sentence of the model's explanation and drop the rest.

    Smaller models narrate their own SQL no matter how the prompt is worded —
    "This query joins X with Y, then groups by Z…". The first sentence is
    reliably the useful one; the rest is the model explaining itself to itself.
    Trimming here rather than in the prompt means it holds for every provider.
    """
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""
    for i, ch in enumerate(cleaned):
        if ch == "." and i + 1 < len(cleaned) and cleaned[i + 1] == " ":
            return cleaned[: i + 1]
    return cleaned if cleaned.endswith(".") else cleaned + "."


def _summarise(question: str, plan: QueryPlan, columns: list[str], rows: list[dict[str, Any]]) -> str:
    """Compose the user-facing answer from the result set, in code.

    No model sees these rows. The text is assembled from the shape of the
    result — a scalar reads as a sentence, a small table reads as a list, a
    large one reads as a count plus its head.
    """
    explanation = _first_sentence(plan.explanation)

    if not rows:
        base = "No records matched that question."
        return f"{base} {explanation}".strip()

    if len(rows) == 1 and len(columns) == 1:
        value = rows[0][columns[0]]
        return f"{columns[0]}: {value}. {explanation}".strip()

    if len(rows) == 1:
        pairs = ", ".join(f"{k}: {v}" for k, v in rows[0].items())
        return f"One matching record — {pairs}. {explanation}".strip()

    lead = f"{len(rows)} row{'s' if len(rows) != 1 else ''} returned"
    if len(rows) >= 500:
        lead += " (capped at the 500-row limit)"

    label_col = next(
        (c for c in columns if c.lower() in {"name", "districtname", "unitname", "crimegroupname", "status"}),
        None,
    )
    value_col = next(
        (c for c in columns if c.lower().startswith(("count", "total", "rate", "sum", "avg", "n_"))),
        None,
    )
    if label_col and value_col:
        head = "; ".join(f"{r[label_col]}: {r[value_col]}" for r in rows[:5])
        more = f" (+{len(rows) - 5} more)" if len(rows) > 5 else ""
        return f"{lead}. Top results — {head}{more}. {explanation}".strip()

    return f"{lead}, with columns {', '.join(columns)}. {explanation}".strip()


def ask(db: Session, question: str, source: str | None = None) -> AskResult:
    """Answer a natural-language question against the configured data source."""
    started = time.perf_counter()
    settings = get_settings()
    source = (source or settings.ask_default_source).lower()
    if source not in (SOURCE_LOCAL, SOURCE_CATALYST):
        raise AskFailed(f"Unknown data source {source!r}. Use 'local' or 'catalyst'.")

    question = (question or "").strip()
    if not question:
        raise AskFailed("Ask a question.")
    if len(question) > 1000:
        raise AskFailed("That question is too long. Keep it under 1000 characters.")

    # 1. Identifiers out before anything leaves the network.
    scrubbed = scrub(question)

    # 2. The only step involving the model. It sees the schema and this text.
    try:
        planner = build_planner()
        plan = planner.plan(scrubbed.text, source, _dialect(source))
    except PlannerUnavailable as exc:
        raise AskFailed("The query planner is unavailable.", detail=str(exc)) from exc

    if not plan.answerable:
        reason = plan.unanswerable_reason or "That question cannot be answered from the available tables."
        return AskResult(
            answer=reason,
            query="",
            rows=[],
            evidence=[],
            columns=[],
            source=source,
            model=plan.model or planner.name,
            answerable=False,
            redacted_identifiers=scrubbed.redacted_count,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )

    # 3. Real identifiers back in, locally. 4. Then re-check every prompt rule as a hard rule.
    sql = rehydrate(plan.sql, scrubbed.mapping)
    try:
        sql = validate_query(sql, source)
    except QueryRejected as exc:
        log.warning("Rejected generated query for source=%s: %s", source, exc)
        raise AskFailed(f"The generated query was rejected: {exc}") from exc

    # 4b. Evidence is mandatory per BACKEND.md, and asking the model for it in
    # the prompt is not the same as getting it. Add the key ourselves when the
    # query enumerates rows and the model left it out.
    sql, added_key = add_identifier(sql, source)
    optional_inner_joins = joins_on_optional(sql, source)

    # 5. Execution never leaves the jurisdiction.
    try:
        if source == SOURCE_CATALYST:
            columns, rows = _execute_catalyst(sql)
        else:
            columns, rows = _execute_local(db, sql)
    except CatalystError as exc:
        raise AskFailed("The Catalyst Data Store could not run that query.", detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface the DB error as a user-safe message
        log.warning("Query execution failed: %s", exc)
        raise AskFailed("The generated query failed to execute against the database.", detail=str(exc)) from exc

    evidence = _collect_evidence(rows)
    notes: list[str] = []

    if added_key:
        notes.append(f"Added {added_key} to the results so each row can be traced to its record.")

    if integer_division_risk(sql):
        notes.append(
            "This rate was computed with integer division, so the values are truncated to whole "
            "numbers and the ranking may be wrong. Ask again for the rate 'as a decimal' to get "
            "an accurate ordering."
        )

    if rows and not evidence:
        notes.append(
            "This result is an aggregate with no per-record identifier, so it cannot be traced to "
            "individual records."
        )

    # An inner join on a nullable column drops rows rather than showing them
    # blank, so "no records matched" can mean "the record exists but that field
    # is empty". Say so instead of letting a wrong answer stand unqualified.
    if optional_inner_joins and not is_aggregate(sql):
        joined = ", ".join(optional_inner_joins)
        if not rows:
            notes.append(
                f"No rows came back, but this query inner-joins on {joined}, which may be empty. "
                "A matching record may exist with that field unset — try asking without it."
            )
        else:
            notes.append(
                f"This query inner-joins on {joined}, which may be empty; records with that field "
                "unset are not included in the count."
            )

    if scrubbed.redacted_count:
        notes.append(
            f"{scrubbed.redacted_count} identifier(s) in the question were replaced with placeholders "
            "before the question was sent to the model, and substituted back locally."
        )

    return AskResult(
        answer=_summarise(question, plan, columns, rows),
        query=sql,
        rows=rows,
        evidence=evidence,
        columns=columns,
        source=source,
        model=plan.model or planner.name,
        redacted_identifiers=scrubbed.redacted_count,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        notes=notes,
    )


def schema_summary(source: str) -> list[dict[str, Any]]:
    """The catalogue as data, for a UI that wants to show what can be asked about."""
    return [
        {
            "table": t.name,
            "description": t.description,
            "columns": [{"name": c.name, "type": c.type, "description": c.description} for c in t.columns],
        }
        for t in tables_for(source)
    ]
