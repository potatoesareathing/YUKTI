"""Versioned API routes: dossier PDF, multi-source ingest, syndicate finder, RBAC demos."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth import UserDep
from app.db import get_db
from app.envelope import ok
from app.models_orm import DossierExport
from app.rbac import filter_fir_records
from app.services.dossier import build_dossier
from app.services.dossier_pdf import render_ksp_dossier_pdf
from app.services import multisource

router = APIRouter(prefix="/api/v1")


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
    return ok(multisource.syndicate_paths(db, a, b, maxHops))


@router.post("/rbac/mask-preview")
def mask_preview(records: list[dict], user: UserDep):
    """Utility endpoint for tests/UI: apply FIR scope + sensitive masking."""
    return ok(filter_fir_records(records, user))


@router.get("/me")
def me(user: UserDep):
    return ok(user.model_dump())
