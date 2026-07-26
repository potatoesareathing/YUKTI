"""Publish snapshots without re-running heavy ETL (use after seed or for warm cache)."""

from app.db import SessionLocal, init_db
from app.jobs.publish_snapshots import build_and_publish
from app.redis_client import reset_redis
from app.services.snapshot import mem_clear


def main() -> None:
    init_db()
    reset_redis()
    mem_clear()
    db = SessionLocal()
    try:
        build_and_publish(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
