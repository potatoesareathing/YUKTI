"""Cross-jurisdiction MO similarity + emerging pattern alerts."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models_orm import CctnsFir, MoPatternAlert
from app.services.realtime import bus


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def cosine_bag(a: list[str], b: list[str]) -> float:
    if not a or not b:
        return 0.0
    fa: dict[str, int] = {}
    fb: dict[str, int] = {}
    for t in a:
        fa[t] = fa.get(t, 0) + 1
    for t in b:
        fb[t] = fb.get(t, 0) + 1
    keys = set(fa) | set(fb)
    dot = sum(fa.get(k, 0) * fb.get(k, 0) for k in keys)
    na = sum(v * v for v in fa.values()) ** 0.5
    nb = sum(v * v for v in fb.values()) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def mo_similarity(meta_a: dict[str, Any] | None, meta_b: dict[str, Any] | None) -> dict[str, Any]:
    a = meta_a or {}
    b = meta_b or {}
    tags_a = set(str(t).lower() for t in (a.get("mo_tags") or []))
    tags_b = set(str(t).lower() for t in (b.get("mo_tags") or []))
    jac = jaccard(tags_a, tags_b)
    cos = cosine_bag(sorted(tags_a), sorted(tags_b))
    inter = len(tags_a & tags_b)
    smaller = min(len(tags_a), len(tags_b)) or 1
    overlap = inter / smaller
    # Emphasize shared-tag coverage so near-identical MOs clear the 80% SCRB bar
    score = 0.25 * jac + 0.25 * cos + 0.5 * overlap
    shared = sorted(tags_a & tags_b)
    return {
        "score": round(score, 4),
        "score_pct": round(score * 100, 1),
        "jaccard": round(jac, 4),
        "cosine": round(cos, 4),
        "overlap": round(overlap, 4),
        "shared_tags": shared,
    }


def _alert_id(a: str, b: str) -> str:
    pair = "|".join(sorted([a, b]))
    return "moalert:" + hashlib.sha1(pair.encode()).hexdigest()[:16]


def match_against_history(db: Session, fir: CctnsFir) -> list[dict[str, Any]]:
    """Compare new FIR MO against other districts; raise alerts when score > threshold."""
    settings = get_settings()
    threshold = settings.mo_match_threshold
    meta = fir.parsed_mo_metadata or {}
    others = (
        db.query(CctnsFir)
        .filter(CctnsFir.id != fir.id)
        .order_by(CctnsFir.fir_timestamp.desc())
        .limit(200)
        .all()
    )
    alerts: list[dict[str, Any]] = []
    for other in others:
        if (other.district_id or "") == (fir.district_id or ""):
            continue
        sim = mo_similarity(meta, other.parsed_mo_metadata)
        if sim["score"] < threshold:
            continue
        aid = _alert_id(fir.id, other.id)
        existing = db.get(MoPatternAlert, aid)
        payload = {
            "type": "emerging_pattern",
            "fir_a": fir.id,
            "fir_b": other.id,
            "district_a": fir.district_id,
            "district_b": other.district_id,
            **sim,
            "comparison": {
                "a": {
                    "id": fir.id,
                    "district": fir.district_id,
                    "crime_head": fir.crime_head_name,
                    "mo": fir.parsed_mo_metadata,
                    "narrative": (fir.raw_kannada_narrative or "")[:400],
                },
                "b": {
                    "id": other.id,
                    "district": other.district_id,
                    "crime_head": other.crime_head_name,
                    "mo": other.parsed_mo_metadata,
                    "narrative": (other.raw_kannada_narrative or "")[:400],
                },
            },
        }
        if existing is None:
            db.add(
                MoPatternAlert(
                    id=aid,
                    fir_a_id=fir.id,
                    fir_b_id=other.id,
                    district_a=str(fir.district_id or ""),
                    district_b=str(other.district_id or ""),
                    score=sim["score"],
                    shared_tags=sim["shared_tags"],
                    payload=payload,
                )
            )
        else:
            existing.score = sim["score"]
            existing.shared_tags = sim["shared_tags"]
            existing.payload = payload
        alerts.append(payload)
    if alerts:
        db.commit()
    return alerts


async def publish_pattern_alerts(alerts: list[dict[str, Any]]) -> None:
    for a in alerts:
        await bus.publish("fir", {"event": "mo_pattern_alert", **a})
        await bus.publish("alerts", {"event": "mo_pattern_alert", **a})


def list_pattern_alerts(db: Session, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.query(MoPatternAlert).order_by(MoPatternAlert.created_at.desc()).limit(limit).all()
    out = []
    for r in rows:
        item = dict(r.payload or {})
        item.update(
            {
                "id": r.id,
                "score": r.score,
                "score_pct": round(r.score * 100, 1),
                "shared_tags": r.shared_tags,
                "created_at": (r.created_at or datetime.now(tz=timezone.utc)).isoformat(),
            }
        )
        out.append(item)
    return out
