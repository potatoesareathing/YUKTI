"""CCTNS FIR ingestion: webhook, Catalyst-backed poller fallback, NLP + MO match."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models_orm import CaseMaster, CctnsFir, CrimeHead, District, Unit, Warrant
from app.services.kannada_nlp import extract_mo_entities
from app.services.mo_match import match_against_history, publish_pattern_alerts
from app.services.realtime import bus

# Sample Kannada narratives when Catalyst FIR has English-only narrative
_SYNTHETIC_KN_TEMPLATES = [
    "ಕುಖ್ಯಾತ ರೌಡಿ ಸ್ಟಾಕರ್ ಆರೋಪಿ ಕಪ್ಪು ಬಣ್ಣದ ಪಲ್ಸರ್ ಬಳಸಿ ಒಂಟಿ ಮಹಿಳೆಯರನ್ನು ಗುರಿಮಾಡಿ ಸರಗಳ್ಳತನ ಮಾಡಿದ. ಆಯುಧ: ಕಬ್ಬಿಣದ ರಾಡ್.",
    "ಮನೆಯ ಬೀಗ ಒಡೆದು ದರೋಡೆ. ಆರೋಪಿಗಳು ಲಾಂಗ್ ಹಾಗೂ ಮಾರಕಾಸ್ತ್ರ ಬಳಸಿದ್ದಾರೆ. ವಾಹನ KA-01-AB-1234.",
    "ರಾತ್ರಿ ವೇಳೆ ಸರ ಕದಿಯುವ ಘಟನೆ. ಸ್ಕೂಟರ್ ಮೇಲೆ ಇಬ್ಬರು ಆರೋಪಿಗಳು. ಬೆಂಗಳೂರು ನಗರ.",
]


def _now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _fir_event(row: CctnsFir) -> dict[str, Any]:
    return {
        "event": "fir_ingested",
        "cctns_fir_id": row.id,
        "case_id": row.case_id,
        "police_station_code": row.police_station_code,
        "district_id": row.district_id,
        "fir_timestamp": row.fir_timestamp,
        "crime_group_name": row.crime_group_name,
        "crime_head_name": row.crime_head_name,
        "lat": row.lat,
        "lng": row.lng,
        "is_synced_realtime": row.is_synced_realtime,
        "parsed_mo_metadata": row.parsed_mo_metadata,
        "source": row.source,
    }


def ingest_fir_payload(db: Session, payload: dict[str, Any], source: str = "webhook") -> dict[str, Any]:
    """Upsert CCTNS FIR, run Kannada NLP, match MO across districts, return event."""
    fir_id = str(
        payload.get("cctns_fir_id")
        or payload.get("fir_id")
        or payload.get("id")
        or ""
    ).strip()
    if not fir_id:
        # Deterministic id from content
        raw = str(payload)
        fir_id = "CCTNS-" + hashlib.sha1(raw.encode()).hexdigest()[:12]

    station = str(payload.get("police_station_code") or payload.get("station_code") or "")
    district = str(payload.get("district_id") or payload.get("district") or "")
    ts = int(payload.get("fir_timestamp") or payload.get("timestamp") or payload.get("registered_at") or _now_ms())
    group = str(payload.get("crime_group_name") or payload.get("crime_group") or "")
    head = str(payload.get("crime_head_name") or payload.get("crime_head") or "")
    lat = float(payload.get("lat") or payload.get("latitude") or 0)
    lng = float(payload.get("lng") or payload.get("lon") or payload.get("longitude") or 0)
    narrative = str(
        payload.get("raw_kannada_narrative")
        or payload.get("kannada_narrative")
        or payload.get("narrative")
        or ""
    )

    case_id = payload.get("case_id")
    mo_fields: dict[str, str] = {}
    if case_id:
        case = db.get(CaseMaster, str(case_id))
        if case:
            mo_fields = {
                "mo_entry": case.mo_entry or "",
                "mo_target": case.mo_target or "",
                "mo_tools": case.mo_tools or "",
                "mo_timing": case.mo_timing or "",
            }
            if not narrative:
                narrative = case.raw_kannada_narrative or case.narrative or ""
            if lat == 0 and lng == 0:
                lat, lng = case.lat, case.lon
            if not district:
                dist = db.get(District, case.district_id)
                district = dist.name if dist else str(case.district_id)
            if not station:
                station = case.police_station_code or case.unit_id
            if not head:
                ch = db.get(CrimeHead, case.crime_head_id)
                head = ch.name if ch else ""

    if not narrative:
        # Synthetic Kannada only when Catalyst narrative missing
        narrative = _SYNTHETIC_KN_TEMPLATES[hash(fir_id) % len(_SYNTHETIC_KN_TEMPLATES)]

    meta = extract_mo_entities(narrative, mo_fields)

    row = db.get(CctnsFir, fir_id)
    if row is None:
        row = CctnsFir(id=fir_id)
        db.add(row)
    row.case_id = str(case_id) if case_id else row.case_id
    row.police_station_code = station
    row.district_id = district
    row.fir_timestamp = ts
    row.crime_group_name = group
    row.crime_head_name = head
    row.lat = lat
    row.lng = lng
    row.raw_kannada_narrative = narrative
    row.is_synced_realtime = True
    row.parsed_mo_metadata = meta
    row.source = source

    # Mirror onto CaseMaster when linked
    if row.case_id:
        case = db.get(CaseMaster, row.case_id)
        if case:
            case.cctns_fir_id = fir_id
            case.police_station_code = station or case.police_station_code
            case.fir_timestamp = ts
            case.crime_group_name = group or case.crime_group_name
            case.crime_head_name = head or case.crime_head_name
            case.raw_kannada_narrative = narrative
            case.is_synced_realtime = True
            case.parsed_mo_metadata = meta
            if lat and lng:
                case.lat = lat
                case.lon = lng

    db.commit()
    db.refresh(row)

    alerts = match_against_history(db, row)
    event = _fir_event(row)
    event["mo_alerts"] = alerts
    return event


async def publish_fir_event(event: dict[str, Any]) -> None:
    await bus.publish("fir", event)
    alerts = event.get("mo_alerts")
    if alerts:
        await publish_pattern_alerts(alerts)


def hydrate_from_catalyst(db: Session, limit: int = 40) -> dict[str, Any]:
    """Seed CCTNS mirror from Catalyst CaseMaster when live feed empty."""
    existing = db.query(CctnsFir).count()
    if existing > 0:
        return {"status": "already", "count": existing}

    cases = (
        db.query(CaseMaster)
        .filter(CaseMaster.in_sample.is_(True))
        .order_by(CaseMaster.registered_at.desc())
        .limit(limit)
        .all()
    )
    created = 0
    for case in cases:
        dist = db.get(District, case.district_id)
        ch = db.get(CrimeHead, case.crime_head_id)
        unit = db.get(Unit, case.unit_id)
        fir_id = case.cctns_fir_id or f"CAT-{case.id}"
        payload = {
            "cctns_fir_id": fir_id,
            "case_id": case.id,
            "police_station_code": case.police_station_code or (unit.id if unit else case.unit_id),
            "district_id": dist.name if dist else str(case.district_id),
            "fir_timestamp": case.fir_timestamp or case.registered_at,
            "crime_group_name": case.crime_group_name or "IPC",
            "crime_head_name": case.crime_head_name or (ch.name if ch else ""),
            "lat": case.lat,
            "lng": case.lon,
            "raw_kannada_narrative": case.raw_kannada_narrative or case.narrative or "",
        }
        ingest_fir_payload(db, payload, source="catalyst")
        created += 1
    return {"status": "hydrated", "created": created}


def poll_delta(db: Session) -> list[dict[str, Any]]:
    """Fetch CCTNS staging deltas or synthesize from new Catalyst cases / warrants."""
    settings = get_settings()
    events: list[dict[str, Any]] = []

    if settings.cctns_staging_url:
        try:
            with httpx.Client(timeout=15.0) as client:
                r = client.get(
                    settings.cctns_staging_url,
                    headers={"X-API-Key": settings.cctns_api_key},
                )
                r.raise_for_status()
                data = r.json()
            records = data if isinstance(data, list) else data.get("records") or data.get("firs") or []
            for rec in records:
                events.append(ingest_fir_payload(db, dict(rec), source="poller"))
            return events
        except Exception as exc:  # noqa: BLE001 — fall through to Catalyst
            print(f"CCTNS poll staging failed: {exc}")

    # Catalyst fallback: pick CaseMaster rows not yet mirrored
    mirrored = {r.case_id for r in db.query(CctnsFir.case_id).filter(CctnsFir.case_id.isnot(None)).all()}
    cases = (
        db.query(CaseMaster)
        .filter(CaseMaster.in_sample.is_(True))
        .order_by(CaseMaster.registered_at.desc())
        .limit(8)
        .all()
    )
    for case in cases:
        if case.id in mirrored:
            continue
        dist = db.get(District, case.district_id)
        ch = db.get(CrimeHead, case.crime_head_id)
        payload = {
            "cctns_fir_id": case.cctns_fir_id or f"POLL-{case.id}",
            "case_id": case.id,
            "police_station_code": case.unit_id,
            "district_id": dist.name if dist else str(case.district_id),
            "fir_timestamp": case.registered_at,
            "crime_group_name": "IPC",
            "crime_head_name": ch.name if ch else "",
            "lat": case.lat,
            "lng": case.lon,
            "raw_kannada_narrative": case.raw_kannada_narrative or case.narrative or "",
        }
        events.append(ingest_fir_payload(db, payload, source="poller"))
        if len(events) >= 3:
            break

    # NBW delta signal (active warrants) — published as secondary events
    warrants = db.query(Warrant).filter(Warrant.status == "Active").limit(5).all()
    for w in warrants:
        events.append(
            {
                "event": "nbw_active",
                "warrant_id": w.id,
                "person_id": w.person_id,
                "warrant_type": w.warrant_type,
                "court_name": w.court_name,
                "issued_at": w.issued_at,
            }
        )
    return events


_poller_task: asyncio.Task | None = None


async def _poller_loop() -> None:
    settings = get_settings()
    interval = max(15, int(settings.cctns_poll_seconds or 60))
    while True:
        try:
            db = SessionLocal()
            try:
                events = poll_delta(db)
                for ev in events:
                    await publish_fir_event(ev)
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            print(f"CCTNS poller error: {exc}")
        await asyncio.sleep(interval)


def start_cctns_poller() -> None:
    global _poller_task
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _poller_task and not _poller_task.done():
        return
    _poller_task = loop.create_task(_poller_loop(), name="cctns-poller")


def list_recent_firs(db: Session, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.query(CctnsFir).order_by(CctnsFir.fir_timestamp.desc()).limit(limit).all()
    return [_fir_event(r) for r in rows]
