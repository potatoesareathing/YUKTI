from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.routes import router
from app.api.v1_routes import router as v1_router
from app.config import get_settings
from app.db import SessionLocal, init_db
from app.services.snapshot import load, load_envelope_bytes, mem_set

settings = get_settings()

WARM_KEYS = (
    "bootstrap",
    "districts",
    "state_totals",
    "incidents",
    "stations",
    "graph",
    "communities",
    "offenders",
    "flows",
    "alerts",
    "risk_scores",
    "anomalies",
    "models",
    "series_all",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        for key in WARM_KEYS:
            val = load(db, key)
            if val is not None:
                mem_set(key, val)
                load_envelope_bytes(db, key)
    finally:
        db.close()
    yield


app = FastAPI(title="YUKTI API", version="1.2.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(v1_router)
