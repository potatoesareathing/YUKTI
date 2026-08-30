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
        # Overlay CDR/ANPR/bank onto Catalyst persons when missing
        from app.services.multisource import ensure_multisource_overlay

        result = ensure_multisource_overlay(db)
        print(f"multisource overlay: {result.get('status')} multi={result.get('multi_source_nodes')}")

        from app.services import cctns as cctns_svc

        hyd = cctns_svc.hydrate_from_catalyst(db)
        print(f"cctns hydrate: {hyd}")
    finally:
        db.close()

    from app.services.cctns import start_cctns_poller

    start_cctns_poller()
    yield


app = FastAPI(title="YUKTI API", version="1.4.0", lifespan=lifespan)
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


def _api_index() -> dict:
    return {
        "service": "YUKTI API",
        "version": app.version,
        "status": "ok",
        "links": {
            "health": "/api/health",
            "ready": "/api/ready",
            "docs": "/docs",
            "openapi": "/openapi.json",
        },
        "routes": {
            "me": "GET /api/v1/me",
            "dossier": "GET /api/v1/suspects/{id}/dossier",
            "dossier_pdf": "GET /api/v1/suspects/{id}/dossier-pdf",
            "graph": "GET /api/graph",
            "graph_multisource": "POST /api/v1/graph/ensure-multisource",
            "cctns_webhook": "POST /api/v1/cctns/fir-webhook",
            "cctns_stream": "GET /api/v1/cctns/stream",
            "cctns_firs": "GET /api/v1/cctns/firs",
            "mo_pattern_alerts": "GET /api/v1/mo/pattern-alerts",
            "beat_feed": "GET /api/v1/beat/feed",
            "beat_red_zones": "GET /api/v1/beat/red-zones",
            "person_intel_dashboard": "GET /api/v1/person-intel/dashboard",
            "person_intel_alerts": "GET /api/v1/person-intel/alerts",
            "person_intel_search": "GET /api/v1/person-intel/search",
            "person_intel_profile": "GET /api/v1/person-intel/persons/{id}",
            "person_intel_match": "GET|POST /api/v1/person-intel/match",
        },
    }


@app.get("/")
def root():
    return _api_index()


@app.get("/api")
def api_root():
    return _api_index()
