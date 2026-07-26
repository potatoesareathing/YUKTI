from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import UserDep
from app.config import get_settings
from app.db import get_db
from app.envelope import ok
from app.models_orm import AuditLog
from app.redis_client import redis_ping
from app.schemas import AskAnswer, AskBody, AuditBody
from app.services.bootstrap import bootstrap
from app.services.districts import get_districts, state_totals
from app.services.flows import get_district_flows
from app.services.graph import get_communities, get_graph
from app.services.incidents import get_incidents
from app.services.models_svc import get_anomalies, get_models, get_risk_scores
from app.services.nl_query import AskFailed, ask, schema_summary
from app.services.offenders import get_offender_profiles
from app.services.series import get_active_alerts, get_series
from app.services.snapshot import load, load_envelope_bytes
from app.services.stations import get_stations

router = APIRouter(prefix="/api")


def _cached(db: Session, name: str) -> Response | None:
    raw = load_envelope_bytes(db, name)
    if raw is None:
        return None
    return Response(content=raw, media_type="application/json")


def _audit_async(db: Session, user: str, action: str, path: str, refs: list | None = None, detail: str = "") -> None:
    settings = get_settings()
    if not settings.audit_reads and action == "query":
        return
    try:
        db.add(
            AuditLog(
                user_id=user,
                action=action,
                path=path,
                resource_refs=refs or [],
                detail=detail,
            )
        )
        db.commit()
    except Exception:
        db.rollback()


@router.get("/health")
def health():
    return ok({"status": "ok"})


@router.get("/ready")
def ready(db: Session = Depends(get_db)):
    checks = {"database": False, "redis": redis_ping(), "snapshots": False}
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception:
        checks["database"] = False
    checks["snapshots"] = load(db, "bootstrap") is not None
    healthy = checks["database"] and checks["snapshots"]
    return ok({"ready": healthy, "checks": checks})


@router.get("/districts")
def districts(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "districts")
    if cached:
        return cached
    data = get_districts(db)
    return ok([d.model_dump() for d in data], total=len(data))


@router.get("/state-totals")
def totals(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "state_totals")
    if cached:
        return cached
    data = state_totals(db)
    return ok(data.model_dump())


@router.get("/incidents")
def incidents(
    user: UserDep,
    db: Session = Depends(get_db),
    districts: list[str] | None = Query(None),
    categories: list[str] | None = Query(None),
    from_ms: int | None = Query(None, alias="from"),
    to_ms: int | None = Query(None, alias="to"),
    anomalousOnly: bool = False,
):
    if not any([districts, categories, from_ms is not None, to_ms is not None, anomalousOnly]):
        cached = _cached(db, "incidents")
        if cached:
            return cached
    data = get_incidents(db, districts, categories, from_ms, to_ms, anomalousOnly)
    return ok([i.model_dump() for i in data], total=len(data), limit=len(data))


@router.get("/stations")
def stations(user: UserDep, district: str | None = None, db: Session = Depends(get_db)):
    if district is None:
        cached = _cached(db, "stations")
        if cached:
            return cached
    data = get_stations(db, district)
    return ok([s.model_dump() for s in data], total=len(data))


@router.get("/series")
def series(user: UserDep, category: str, district: str | None = None, db: Session = Depends(get_db)):
    data = get_series(db, category, district)
    return ok(data.model_dump())


@router.get("/alerts")
def alerts(user: UserDep, weeks: int = 10, db: Session = Depends(get_db)):
    if weeks == 10:
        cached = _cached(db, "alerts")
        if cached:
            return cached
    data = get_active_alerts(db, weeks)
    return ok([a.model_dump() for a in data], total=len(data))


@router.get("/graph")
def graph(user: UserDep, rootId: str | None = None, depth: int = 2, db: Session = Depends(get_db)):
    if rootId is None:
        cached = _cached(db, "graph")
        if cached:
            return cached
    data = get_graph(db, rootId, depth)
    return ok(data.model_dump())


@router.get("/communities")
def communities(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "communities")
    if cached:
        return cached
    data = get_communities(db)
    return ok([c.model_dump() for c in data], total=len(data))


@router.get("/offenders")
def offenders(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "offenders")
    if cached:
        return cached
    data = get_offender_profiles(db)
    return ok([o.model_dump() for o in data], total=len(data))


@router.get("/flows")
def flows(user: UserDep, minTies: int = 2, db: Session = Depends(get_db)):
    if minTies == 2:
        cached = _cached(db, "flows")
        if cached:
            return cached
    data = get_district_flows(db, minTies)
    return ok(data.model_dump())


@router.get("/risk-scores")
def risk_scores(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "risk_scores")
    if cached:
        return cached
    data = get_risk_scores(db)
    return ok([r.model_dump() for r in data], total=len(data))


@router.get("/anomalies")
def anomalies(user: UserDep, limit: int = 24, db: Session = Depends(get_db)):
    if limit == 24:
        cached = _cached(db, "anomalies")
        if cached:
            return cached
    data = get_anomalies(db, limit)
    return ok([a.model_dump() for a in data], total=len(data))


@router.get("/models")
def models(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "models")
    if cached:
        return cached
    data = get_models(db)
    return ok([m.model_dump() for m in data], total=len(data))


@router.get("/bootstrap")
def bootstrap_route(user: UserDep, db: Session = Depends(get_db)):
    cached = _cached(db, "bootstrap")
    if cached:
        return cached
    data = bootstrap(db)
    return ok(data.model_dump())


@router.post("/audit")
def audit_write(body: AuditBody, request: Request, user: UserDep, db: Session = Depends(get_db)):
    _audit_async(db, user, body.action, request.url.path, body.resource_refs, body.detail)
    return ok({"logged": True})


@router.get("/ask/schema")
def ask_schema(user: UserDep, source: str | None = None):
    """The tables and columns the assistant can answer from."""
    settings = get_settings()
    return ok(schema_summary(source or settings.ask_default_source))


@router.post("/ask")
def ask_route(body: AskBody, request: Request, user: UserDep, db: Session = Depends(get_db)):
    """Answer a natural-language question about the crime database.

    The question is translated to a read-only query by a model that sees only
    the schema catalogue; the query runs here. Every call is written to the
    audit log per §10.1 — the question, the query it produced, and the records
    it touched — whether or not it succeeded.
    """
    settings = get_settings()
    if not settings.ask_enabled:
        raise HTTPException(status_code=503, detail="The assistant is disabled.")

    try:
        result = ask(db, body.question, body.source)
    except AskFailed as exc:
        _audit_async(
            db,
            user,
            "ask_failed",
            request.url.path,
            [],
            f"q={body.question!r} error={exc} detail={exc.detail}",
        )
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _audit_async(
        db,
        user,
        "ask",
        request.url.path,
        result.evidence,
        f"q={body.question!r} source={result.source} model={result.model} query={result.query!r}",
    )

    return ok(
        AskAnswer(
            answer=result.answer,
            query=result.query,
            columns=result.columns,
            rows=result.rows,
            evidence=result.evidence,
            source=result.source,
            model=result.model,
            answerable=result.answerable,
            redactedIdentifiers=result.redacted_identifiers,
            elapsedMs=result.elapsed_ms,
            notes=result.notes,
        ).model_dump(),
        total=len(result.rows),
    )
