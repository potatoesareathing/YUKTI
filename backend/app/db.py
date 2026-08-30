from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=1 if settings.database_url.startswith("sqlite") else settings.db_pool_size,
    max_overflow=0 if settings.database_url.startswith("sqlite") else settings.db_max_overflow,
    pool_recycle=1800,
    connect_args=connect_args,
)

if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _sqlite_pragma(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from app import models_orm  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_case_master_cctns()


def _migrate_sqlite_case_master_cctns() -> None:
    """Add CCTNS columns to existing SQLite case_master without rebuild."""
    if not settings.database_url.startswith("sqlite"):
        return
    cols = {
        "cctns_fir_id": "VARCHAR(64)",
        "police_station_code": "VARCHAR(64)",
        "fir_timestamp": "BIGINT",
        "crime_group_name": "VARCHAR(128)",
        "crime_head_name": "VARCHAR(128)",
        "raw_kannada_narrative": "TEXT",
        "is_synced_realtime": "BOOLEAN DEFAULT 0",
        "parsed_mo_metadata": "JSON",
    }
    with engine.begin() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(case_master)").fetchall()}
        for name, ddl in cols.items():
            if name not in existing:
                conn.exec_driver_sql(f"ALTER TABLE case_master ADD COLUMN {name} {ddl}")
