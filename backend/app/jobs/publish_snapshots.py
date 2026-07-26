"""Build and publish all dashboard snapshots after nightly ETL."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.config import get_settings
from app.schemas import CRIME_CATEGORIES, TrendSeries
from app.services.districts import get_districts, state_totals
from app.services.flows import get_district_flows
from app.services.graph import get_communities, get_graph
from app.services.incidents import get_incidents
from app.services.models_svc import get_anomalies, get_models, get_risk_scores
from app.services.offenders import get_offender_profiles
from app.services.series import get_active_alerts, load_all_series
from app.services.snapshot import publish_all
from app.services.stations import compute_stations


def build_and_publish(db: Session) -> dict:
    settings = get_settings()
    # Clear Redis series cache key used by load_all_series
    from app.redis_client import cache_delete

    cache_delete("all_series", "districts", "state_totals")

    districts = get_districts(db)
    incidents = get_incidents(db)
    stations = compute_stations(db, incidents, districts)
    network = get_graph(db)
    communities = get_communities(db)
    all_series = load_all_series(db)

    category_series = {
        c: all_series.get(
            f"KA:{c}",
            TrendSeries(key=f"KA:{c}", label=c, points=[], controlLimit=0, breaches=[]),
        ).model_dump()
        for c in CRIME_CATEGORIES
    }
    district_series = {
        f"{d.name}|{c}": all_series[f"{d.name}:{c}"].model_dump()
        for d in districts
        for c in CRIME_CATEGORIES
        if f"{d.name}:{c}" in all_series
    }

    bootstrap = {
        "districts": [d.model_dump() for d in districts],
        "stateTotals": state_totals(db).model_dump(),
        "incidents": [i.model_dump() for i in incidents],
        "stations": [s.model_dump() for s in stations],
        "network": network.model_dump(),
        "communities": [c.model_dump() for c in communities],
        "models": [m.model_dump() for m in get_models(db)],
        "offenders": [o.model_dump() for o in get_offender_profiles(db)],
        "flows": get_district_flows(db).model_dump(),
        "alerts": [a.model_dump() for a in get_active_alerts(db)],
        "riskScores": [r.model_dump() for r in get_risk_scores(db)],
        "anomalies": [a.model_dump() for a in get_anomalies(db)],
        "categorySeries": category_series,
        "districtSeries": district_series,
        "now": settings.now_ms,
        "periodDays": settings.period_days,
    }

    payloads = {
        "bootstrap": bootstrap,
        "districts": bootstrap["districts"],
        "state_totals": bootstrap["stateTotals"],
        "incidents": bootstrap["incidents"],
        "stations": bootstrap["stations"],
        "graph": bootstrap["network"],
        "communities": bootstrap["communities"],
        "offenders": bootstrap["offenders"],
        "flows": bootstrap["flows"],
        "alerts": bootstrap["alerts"],
        "risk_scores": bootstrap["riskScores"],
        "anomalies": bootstrap["anomalies"],
        "models": bootstrap["models"],
        "series_all": {**{f"KA:{k}": v for k, v in category_series.items()}, **{
            k.replace("|", ":"): v for k, v in district_series.items()
        }},
    }
    publish_all(db, payloads)
    print(f"Snapshots published: {', '.join(payloads)}")
    return bootstrap
