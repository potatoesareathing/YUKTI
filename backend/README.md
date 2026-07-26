# YUKTI Backend

See [docs/CATALYST-DEPLOY.md](../docs/CATALYST-DEPLOY.md) for Zoho Catalyst **Slate + AppSail** deployment.

FastAPI service for [docs/BACKEND.md](../docs/BACKEND.md). Dashboard reads are **precomputed nightly** and served from memory → Redis → DB snapshots so hot paths stay under CIAP’s 3s budget.

## Architecture (production shape)

| Layer | Role |
|-------|------|
| Postgres/PostGIS (or SQLite local) | System of record + `api_snapshot` table |
| Redis | Compressed snapshot cache (optional but recommended) |
| Neo4j | Graph sync from nightly (API still serves snapshot) |
| Uvicorn | API workers; GZip; `/api/ready` probes |
| Nightly job | STL/CUSUM → graph → models → **publish snapshots** |

Request path never recomputes STL, risk, or stations.

## Local (SQLite, fast)

```powershell
cd backend
$env:PYTHONPATH = (Get-Location).Path
$env:DATABASE_URL = "sqlite:///./yukti.db"
# venv: $env:LOCALAPPDATA\yukti-venv
& "$env:LOCALAPPDATA\yukti-venv\Scripts\python.exe" -m app.seed.run_seed
& "$env:LOCALAPPDATA\yukti-venv\Scripts\python.exe" -m app.jobs.nightly
& "$env:LOCALAPPDATA\yukti-venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

After data already exists, refresh cache only:

```powershell
python -m app.jobs.publish_only
```

Latency check: `python smoke_latency.py` — expects bootstrap &lt; 3s.

## Full infra (Docker)

```powershell
cd backend
docker compose up --build
```

Brings up Postgres, Redis, Neo4j, MLflow, Keycloak, and API (seed + nightly + 2 workers).

- Health: `GET /api/health`
- Ready: `GET /api/ready` (`database` + `snapshots` required; `redis` reported)
- Docs: http://127.0.0.1:8000/docs

Optional job rerun: `docker compose --profile jobs run --rm nightly`

## Frontend

Root `.env`:

```
VITE_API_BASE_URL=http://127.0.0.1:8000
```

Then `npm run dev`.

## Auth / audit

- `AUTH_BYPASS=true` for local UI (default). Set `false` with Keycloak for real JWT.
- `AUDIT_READS=false` (default) — GETs are not audited for latency; evidence opens use `POST /api/audit`.
