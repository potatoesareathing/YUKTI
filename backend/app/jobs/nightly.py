"""Nightly ETL entrypoint — STL/CUSUM, graph, models, snapshot publish."""

from __future__ import annotations

from app.db import SessionLocal, init_db
from app.jobs.graph_build import build_graph
from app.jobs.publish_snapshots import build_and_publish
from app.jobs.stl_cusum import run_stl_pipeline
from app.jobs.train_models import train_and_persist
from app.redis_client import cache_delete, reset_redis
from app.services.snapshot import mem_clear


def run() -> None:
    init_db()
    reset_redis()
    mem_clear()
    db = SessionLocal()
    try:
        print("Nightly: STL/CUSUM…")
        run_stl_pipeline(db)
        print("Nightly: graph…")
        build_graph(db)
        print("Nightly: models…")
        train_and_persist(db)
        cache_delete("districts", "state_totals", "all_series")
        print("Nightly: publish snapshots…")
        build_and_publish(db)
        print("Nightly complete")
    finally:
        db.close()


if __name__ == "__main__":
    run()
