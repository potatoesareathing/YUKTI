from __future__ import annotations

from sqlalchemy.orm import Session

from app.models_orm import DistrictAggregate
from app.schemas import CRIME_CATEGORIES, DistrictMetrics, StateTotals
from app.services.snapshot import load


def get_districts(db: Session) -> list[DistrictMetrics]:
    cached = load(db, "districts")
    if cached is not None:
        return [DistrictMetrics.model_validate(x) for x in cached]

    rows = db.query(DistrictAggregate).all()
    data = [DistrictMetrics.model_validate(r.payload) for r in rows]
    data.sort(key=lambda d: d.name)
    return data


def state_totals(db: Session) -> StateTotals:
    cached = load(db, "state_totals")
    if cached is not None:
        return StateTotals.model_validate(cached)

    ds = get_districts(db)
    by_category = {c: sum(d.byCategory.get(c, 0) for d in ds) for c in CRIME_CATEGORIES}
    return StateTotals(
        incidents=sum(d.incidents for d in ds),
        byCategory=by_category,
        redZones=sum(1 for d in ds if d.redZone),
        stations=sum(d.stations for d in ds),
        avgClearance=round(sum(d.clearancePct for d in ds) / max(1, len(ds))),
    )
