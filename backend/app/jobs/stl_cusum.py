"""Precompute weekly STL + CUSUM series (Phase 3). Never run per-request."""

from __future__ import annotations

import math

import numpy as np
from sqlalchemy.orm import Session
from statsmodels.tsa.seasonal import STL

from app.config import get_settings
from app.models_orm import CaseMaster, CrimeHead, District, SeriesMeta, WeeklySeries
from app.redis_client import cache_delete
from app.seed.rng import seeded


def _cusum_breaches(residual: np.ndarray, baseline_n: int = 40) -> tuple[float, list[int]]:
    """Two-sided tabular CUSUM on residual; σ from in-control baseline."""
    base = residual[:baseline_n]
    sigma = float(np.std(base, ddof=1)) if len(base) > 2 else 1.0
    sigma = max(sigma, 1e-6)
    k = 0.5 * sigma
    h = 4.2 * sigma
    gp = gm = 0.0
    breaches: list[int] = []
    refractory = 0
    for i, x in enumerate(residual):
        if refractory > 0:
            refractory -= 1
            gp = gm = 0.0
            continue
        gp = max(0.0, gp + x - k)
        gm = max(0.0, gm - x - k)
        if gp > h or gm > h:
            breaches.append(i)
            refractory = 12
            gp = gm = 0.0
    return h, breaches


def _synthetic_weekly(n: int, mean: float, rng) -> np.ndarray:
    t = np.arange(n)
    seasonal = 3.0 * np.sin(2 * math.pi * t / 52)
    trend = np.linspace(0, mean * 0.15, n)
    noise = np.array([rng() - 0.5 for _ in range(n)]) * mean * 0.3
    # inject one level shift in last third for some series
    vals = mean + seasonal + trend + noise
    if rng() > 0.55:
        shift_at = int(n * 0.7)
        vals[shift_at:] += mean * 0.45
    return np.maximum(0, vals)


def run_stl_pipeline(db: Session) -> None:
    settings = get_settings()
    db.query(WeeklySeries).delete()
    db.query(SeriesMeta).delete()
    db.flush()

    heads = db.query(CrimeHead).all()
    districts = db.query(District).all()
    n_weeks = 104
    week_ms = 7 * 86_400_000
    start = settings.now_ms - n_weeks * week_ms

    # State-wide + per-district × category
    targets: list[tuple[int | None, CrimeHead, str]] = []
    for h in heads:
        targets.append((None, h, f"KA:{h.name}"))
        for d in districts:
            targets.append((d.id, h, f"{d.name}:{h.name}"))

    for district_id, head, key in targets:
        # Prefer counts from cases when district-level; else synthetic
        rng = seeded(f"series:{key}")
        if district_id is not None:
            # approximate mean from sample density
            count = (
                db.query(CaseMaster)
                .filter(CaseMaster.district_id == district_id, CaseMaster.crime_head_id == head.id)
                .count()
            )
            mean = max(1.0, count / (settings.period_days / 7))
        else:
            mean = 40 + rng() * 80

        values = _synthetic_weekly(n_weeks, mean, rng)
        try:
            stl = STL(values, period=52, robust=True)
            res = stl.fit()
            trend, seasonal, residual = res.trend, res.seasonal, res.resid
        except Exception:
            trend = values * 0.7
            seasonal = values * 0.2
            residual = values * 0.1

        limit, breaches = _cusum_breaches(np.asarray(residual))
        label = head.name if district_id is None else f"{db.get(District, district_id).name} — {head.name}"
        db.add(
            SeriesMeta(
                district_id=district_id,
                crime_head_id=head.id,
                control_limit=float(limit),
                breaches=breaches,
                label=label,
                key=key,
            )
        )
        for i in range(n_weeks):
            db.add(
                WeeklySeries(
                    district_id=district_id,
                    crime_head_id=head.id,
                    week_index=i,
                    at_ms=start + i * week_ms,
                    value=float(values[i]),
                    trend=float(trend[i]),
                    seasonal=float(seasonal[i]),
                    residual=float(residual[i]),
                )
            )

    db.commit()
    cache_delete(*[f"series:{h.name}:STATE" for h in heads])
    print(f"STL/CUSUM: wrote {len(targets)} series")
