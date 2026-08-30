"""Versioned API routes: dossier PDF, multi-source ingest, CCTNS, beat, MO NLP."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.auth import UserDep
from app.config import get_settings
from app.db import get_db
from app.envelope import ok
from app.models_orm import DossierExport
from app.rbac import filter_fir_records
from app.services import beat as beat_svc
from app.services import cctns as cctns_svc
from app.services import multisource
from app.services.dossier import build_dossier
from app.services.dossier_pdf import render_ksp_dossier_pdf
from app.services.kannada_nlp import extract_mo_entities
from app.services.mo_match import list_pattern_alerts, mo_similarity
from app.services.realtime import bus

router = APIRouter(prefix="/api/v1")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host or ""
    return ""


def _require_cctns_auth(request: Request, x_api_key: str | None) -> None:
    settings = get_settings()
    expected = settings.cctns_api_key
    if not x_api_key or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")
    allow = [p.strip() for p in (settings.cctns_ip_allowlist or "").split(",") if p.strip()]
    if allow:
        ip = _client_ip(request)
        if ip not in allow and ip not in ("127.0.0.1", "::1"):
            raise HTTPException(status_code=403, detail=f"IP not allowlisted: {ip}")


@router.get("/suspects/{suspect_id}/dossier-pdf")
def dossier_pdf(suspect_id: str, user: UserDep, db: Session = Depends(get_db)):
    try:
        dossier = build_dossier(db, suspect_id, user)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    pdf = render_ksp_dossier_pdf(dossier)
    db.add(DossierExport(user_id=user.user_id, suspect_id=suspect_id))
    db.commit()

    filename = f"KSP_Dossier_{suspect_id}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/suspects/{suspect_id}/dossier")
def dossier_json(suspect_id: str, user: UserDep, db: Session = Depends(get_db)):
    try:
        dossier = build_dossier(db, suspect_id, user)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return ok(dossier)


async def _read_ingest_payload(request: Request) -> tuple[str | bytes | list | dict, str]:
    ctype = (request.headers.get("content-type") or "").lower()
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty body — send CSV or JSON")
    if "json" in ctype or raw[:1] in (b"{", b"["):
        try:
            return json.loads(raw.decode("utf-8")), "application/json"
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc
    return raw, ctype or "text/csv"


@router.post("/graph/ingest/cdr")
async def ingest_cdr(request: Request, user: UserDep, db: Session = Depends(get_db)):
    payload, ctype = await _read_ingest_payload(request)
    return ok(multisource.ingest_cdr(db, payload, ctype))


@router.post("/graph/ingest/anpr")
async def ingest_anpr(request: Request, user: UserDep, db: Session = Depends(get_db)):
    payload, ctype = await _read_ingest_payload(request)
    return ok(multisource.ingest_anpr(db, payload, ctype))


@router.post("/graph/ingest/finance")
async def ingest_finance(request: Request, user: UserDep, db: Session = Depends(get_db)):
    payload, ctype = await _read_ingest_payload(request)
    return ok(multisource.ingest_finance(db, payload, ctype))


@router.get("/graph/syndicate-path")
def syndicate_path(
    user: UserDep,
    a: str = Query(..., description="Source node id"),
    b: str = Query(..., description="Target node id"),
    maxHops: int = Query(6, ge=1, le=12),
    db: Session = Depends(get_db),
):
    multisource.ensure_multisource_overlay(db)
    return ok(multisource.syndicate_paths(db, a, b, maxHops))


@router.post("/graph/ensure-multisource")
def ensure_multisource(user: UserDep, db: Session = Depends(get_db), force: bool = False):
    """Hydrate CDR/ANPR/bank from Catalyst persons, or sample CSV if none."""
    return ok(multisource.ensure_multisource_overlay(db, force=force))


@router.post("/cctns/fir-webhook")
async def cctns_fir_webhook(
    request: Request,
    db: Session = Depends(get_db),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    _require_cctns_auth(request, x_api_key)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    event = cctns_svc.ingest_fir_payload(db, body, source="webhook")
    await cctns_svc.publish_fir_event(event)
    return ok(event)


@router.get("/cctns/stream")
async def cctns_stream(request: Request):
    """Server-Sent Events — live FIR / MO alert push for hotspot maps."""

    async def gen():
        q = await bus.subscribe("fir")
        try:
            yield "event: ready\ndata: {\"ok\":true}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield f"event: fir\ndata: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await bus.unsubscribe("fir", q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/cctns/firs")
def cctns_firs(user: UserDep, db: Session = Depends(get_db), limit: int = Query(50, ge=1, le=200)):
    return ok(cctns_svc.list_recent_firs(db, limit))


@router.post("/cctns/hydrate")
def cctns_hydrate(user: UserDep, db: Session = Depends(get_db)):
    return ok(cctns_svc.hydrate_from_catalyst(db))


@router.post("/nlp/extract-mo")
def nlp_extract_mo(body: dict, user: UserDep):
    narrative = str(body.get("raw_kannada_narrative") or body.get("narrative") or "")
    fields = body.get("mo_fields") if isinstance(body.get("mo_fields"), dict) else {}
    return ok(extract_mo_entities(narrative, {str(k): str(v) for k, v in fields.items()}))


@router.post("/mo/compare")
def mo_compare(body: dict, user: UserDep):
    return ok(mo_similarity(body.get("a") or {}, body.get("b") or {}))


@router.get("/mo/pattern-alerts")
def mo_pattern_alerts(user: UserDep, db: Session = Depends(get_db), limit: int = Query(50, ge=1, le=200)):
    return ok(list_pattern_alerts(db, limit))


@router.get("/beat/red-zones")
def beat_red_zones(user: UserDep, db: Session = Depends(get_db)):
    return ok(beat_svc.red_zones(db))


@router.get("/beat/feed")
def beat_feed(
    user: UserDep,
    db: Session = Depends(get_db),
    lat: float = Query(...),
    lng: float = Query(...),
    radiusKm: float = Query(2.0, ge=0.2, le=20),
):
    return ok(beat_svc.beat_feed(db, lat, lng, radiusKm))


@router.post("/beat/geofence-check")
def beat_geofence(body: dict, user: UserDep, db: Session = Depends(get_db)):
    lat = float(body.get("lat") or body.get("latitude") or 0)
    lng = float(body.get("lng") or body.get("lon") or body.get("longitude") or 0)
    return ok(beat_svc.check_geofence(db, lat, lng))


@router.post("/rbac/mask-preview")
def mask_preview(records: list[dict], user: UserDep):
    """Utility endpoint for tests/UI: apply FIR scope + sensitive masking."""
    return ok(filter_fir_records(records, user))


@router.get("/me")
def me(user: UserDep):
    return ok(user.model_dump())
