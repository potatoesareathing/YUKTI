#!/usr/bin/env python3
"""AppSail / local entrypoint — binds Catalyst listen port and bootstraps SQLite snapshots."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure backend package root is on PYTHONPATH
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
lib = ROOT / "lib"
if lib.is_dir() and str(lib) not in sys.path:
    sys.path.insert(0, str(lib))

os.chdir(ROOT)

# Defaults for Catalyst AppSail (override via env in console)
os.environ.setdefault("DATABASE_URL", "sqlite:///./yukti.db")
os.environ.setdefault("AUTH_BYPASS", "true")
os.environ.setdefault("AUDIT_READS", "false")
os.environ.setdefault("ENVIRONMENT", "production")


def ensure_data() -> None:
    """Seed + nightly publish if snapshots are missing (first boot on AppSail)."""
    from app.db import SessionLocal, init_db
    from app.models_orm import ApiSnapshot, District
    from app.jobs.nightly import run as nightly_run
    from app.seed.run_seed import seed

    init_db()
    db = SessionLocal()
    try:
        has_districts = db.query(District).count() > 0
        has_bootstrap = db.get(ApiSnapshot, "bootstrap") is not None
    finally:
        db.close()

    if not has_districts:
        print("AppSail boot: seeding database…")
        db = SessionLocal()
        try:
            seed(db, force=False)
        finally:
            db.close()
        nightly_run()
        return

    if not has_bootstrap:
        print("AppSail boot: publishing snapshots…")
        from app.jobs.publish_only import main as publish_main

        publish_main()


def main() -> None:
    ensure_data()
    import uvicorn

    port = int(os.getenv("X_ZOHO_CATALYST_LISTEN_PORT") or os.getenv("PORT") or "9000")
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting YUKTI API on {host}:{port}")
    uvicorn.run("app.main:app", host=host, port=port, workers=1, log_level="info")


if __name__ == "__main__":
    main()
