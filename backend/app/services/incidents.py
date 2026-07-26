from __future__ import annotations

from sqlalchemy.orm import Session

from app.models_orm import CaseMaster, CrimeHead, District, Employee, Unit
from app.schemas import Incident, ModusOperandi
from app.services.snapshot import load


def _to_incident(
    c: CaseMaster,
    district: str,
    station: str,
    category: str,
    officer: str,
) -> Incident:
    return Incident(
        id=c.id,
        docket=c.crime_no,
        category=category,  # type: ignore[arg-type]
        district=district,
        station=station,
        lonLat=(c.lon, c.lat),
        world=(c.world_x, c.world_z),
        at=c.registered_at,
        status=c.status,  # type: ignore[arg-type]
        mo=ModusOperandi(entry=c.mo_entry, target=c.mo_target, timing=c.mo_timing, tools=c.mo_tools),
        narrative=c.narrative,
        officer=officer,
        anomaly=c.anomaly,
        anomalyScore=c.anomaly_score,
    )


def _query_incidents(
    db: Session,
    districts: list[str] | None = None,
    categories: list[str] | None = None,
    from_ms: int | None = None,
    to_ms: int | None = None,
    anomalous_only: bool = False,
    limit: int = 8000,
) -> list[Incident]:
    q = (
        db.query(CaseMaster, District, Unit, CrimeHead, Employee)
        .join(District, CaseMaster.district_id == District.id)
        .join(Unit, CaseMaster.unit_id == Unit.id)
        .join(CrimeHead, CaseMaster.crime_head_id == CrimeHead.id)
        .outerjoin(Employee, CaseMaster.officer_id == Employee.id)
        .filter(CaseMaster.in_sample.is_(True))
    )
    if districts:
        q = q.filter(District.name.in_(districts))
    if categories:
        q = q.filter(CrimeHead.name.in_(categories))
    if from_ms is not None:
        q = q.filter(CaseMaster.registered_at >= from_ms)
    if to_ms is not None:
        q = q.filter(CaseMaster.registered_at <= to_ms)
    if anomalous_only:
        q = q.filter(CaseMaster.anomaly.is_(True))

    rows = q.order_by(CaseMaster.registered_at.desc()).limit(limit).all()
    return [
        _to_incident(c, d.name, u.name, ch.name, e.name if e else "—")
        for c, d, u, ch, e in rows
    ]


def get_incidents(
    db: Session,
    districts: list[str] | None = None,
    categories: list[str] | None = None,
    from_ms: int | None = None,
    to_ms: int | None = None,
    anomalous_only: bool = False,
    limit: int = 8000,
) -> list[Incident]:
    # Fast path: unfiltered reads from nightly snapshot
    if not any([districts, categories, from_ms is not None, to_ms is not None, anomalous_only]):
        cached = load(db, "incidents")
        if cached is not None:
            return [Incident.model_validate(x) for x in cached[:limit]]

    cached = load(db, "incidents")
    if cached is not None:
        rows = [Incident.model_validate(x) for x in cached]
        out = []
        for i in rows:
            if districts and i.district not in districts:
                continue
            if categories and i.category not in categories:
                continue
            if from_ms is not None and i.at < from_ms:
                continue
            if to_ms is not None and i.at > to_ms:
                continue
            if anomalous_only and not i.anomaly:
                continue
            out.append(i)
            if len(out) >= limit:
                break
        return out

    return _query_incidents(db, districts, categories, from_ms, to_ms, anomalous_only, limit)
