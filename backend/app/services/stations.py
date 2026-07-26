from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from app.schemas import CRIME_CATEGORIES, DistrictMetrics, Incident, StationMetrics
from app.services.districts import get_districts
from app.services.incidents import get_incidents
from app.services.snapshot import load


def compute_stations(
    db: Session,
    incidents: list[Incident] | None = None,
    districts: list[DistrictMetrics] | None = None,
) -> list[StationMetrics]:
    incidents = incidents if incidents is not None else get_incidents(db)
    districts = districts if districts is not None else get_districts(db)
    district_totals = {d.name: d.incidents for d in districts}

    grouped: dict[str, list] = defaultdict(list)
    per_district_sample: dict[str, int] = defaultdict(int)
    for i in incidents:
        key = f"{i.district}|{i.station}"
        grouped[key].append(i)
        per_district_sample[i.district] += 1

    out: list[StationMetrics] = []
    for key, list_i in grouped.items():
        dist = list_i[0].district
        sample_total = per_district_sample[dist] or 1
        share = len(list_i) / sample_total
        by_cat = {c: 0 for c in CRIME_CATEGORIES}
        anomalies = 0
        wx = wz = 0.0
        last_at = 0
        for i in list_i:
            by_cat[i.category] = by_cat.get(i.category, 0) + 1
            if i.anomaly:
                anomalies += 1
            wx += i.world[0]
            wz += i.world[1]
            last_at = max(last_at, i.at)
        n = len(list_i)
        top = max(CRIME_CATEGORIES, key=lambda c: by_cat[c])
        estimated = int(round(share * district_totals.get(dist, n)))
        out.append(
            StationMetrics(
                id=key,
                name=list_i[0].station,
                district=dist,
                world=(wx / n, wz / n),
                sampled=n,
                estimated=estimated,
                byCategory=by_cat,
                topCategory=top,  # type: ignore[arg-type]
                anomalies=anomalies,
                share=share,
                lastAt=last_at,
            )
        )
    out.sort(key=lambda s: (-s.estimated, s.name))
    return out


def get_stations(db: Session, district: str | None = None) -> list[StationMetrics]:
    cached = load(db, "stations")
    if cached is not None:
        rows = [StationMetrics.model_validate(x) for x in cached]
        if district:
            return [s for s in rows if s.district == district]
        return rows
    rows = compute_stations(db)
    if district:
        return [s for s in rows if s.district == district]
    return rows
