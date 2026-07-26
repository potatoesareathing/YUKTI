from __future__ import annotations

from sqlalchemy.orm import Session

from app.config import get_settings
from app.schemas import BootstrapPayload
from app.services.snapshot import load


def bootstrap(db: Session) -> BootstrapPayload:
    cached = load(db, "bootstrap")
    if cached is not None:
        return BootstrapPayload.model_validate(cached)

    # Cold start / first boot — build once and publish
    from app.jobs.publish_snapshots import build_and_publish

    payload = build_and_publish(db)
    return BootstrapPayload.model_validate(payload)


def bootstrap_meta(db: Session) -> dict:
    settings = get_settings()
    cached = load(db, "bootstrap")
    return {
        "cached": cached is not None,
        "now": settings.now_ms,
        "periodDays": settings.period_days,
    }
