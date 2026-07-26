from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models_orm import SeriesMeta, WeeklySeries
from app.redis_client import cache_get, cache_set
from app.schemas import AlertItem, TrendPoint, TrendSeries
from app.services.snapshot import load


def _series_from_rows(meta: SeriesMeta, points: list[WeeklySeries]) -> TrendSeries:
    return TrendSeries(
        key=meta.key,
        label=meta.label,
        points=[
            TrendPoint(at=p.at_ms, value=p.value, trend=p.trend, seasonal=p.seasonal, residual=p.residual)
            for p in points
        ],
        controlLimit=meta.control_limit,
        breaches=list(meta.breaches or []),
    )


def load_all_series(db: Session) -> dict[str, TrendSeries]:
    snap = load(db, "series_all")
    if snap is not None:
        return {k: TrendSeries.model_validate(v) for k, v in snap.items()}

    cached = cache_get("all_series")
    if cached:
        return {k: TrendSeries.model_validate(v) for k, v in cached.items()}

    metas = db.query(SeriesMeta).all()
    points = db.query(WeeklySeries).order_by(WeeklySeries.week_index).all()
    by_key: dict[tuple, list[WeeklySeries]] = defaultdict(list)
    for p in points:
        by_key[(p.district_id, p.crime_head_id)].append(p)

    out: dict[str, TrendSeries] = {}
    for meta in metas:
        rows = by_key.get((meta.district_id, meta.crime_head_id), [])
        out[meta.key] = _series_from_rows(meta, rows)

    cache_set("all_series", {k: v.model_dump() for k, v in out.items()})
    return out


def get_series(db: Session, category: str, district: str | None = None) -> TrendSeries:
    all_series = load_all_series(db)
    key = f"KA:{category}" if district is None else f"{district}:{category}"
    series = all_series.get(key)
    if series:
        return series
    return TrendSeries(
        key=key,
        label=category if district is None else f"{district} — {category}",
        points=[],
        controlLimit=0,
        breaches=[],
    )


def get_active_alerts(db: Session, within_weeks: int = 10) -> list[AlertItem]:
    cached = load(db, "alerts")
    if cached is not None:
        alerts = [AlertItem.model_validate(a) for a in cached]
        if within_weeks >= 10:
            return alerts
        # filter tighter window if requested
        if not alerts:
            return []
        max_at = max(a.at for a in alerts)
        window_ms = within_weeks * 7 * 86_400_000
        return [a for a in alerts if max_at - a.at <= window_ms]

    all_series = load_all_series(db)
    alerts: list[AlertItem] = []
    for series in all_series.values():
        if not series.breaches or not series.points:
            continue
        last_idx = len(series.points) - 1
        for b in series.breaches:
            if last_idx - b <= within_weeks:
                alerts.append(AlertItem(series=series, at=series.points[b].at, index=b))
    alerts.sort(key=lambda a: a.at, reverse=True)
    return alerts[:40]
