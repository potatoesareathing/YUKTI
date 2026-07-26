# Deploy YUKTI on Zoho Catalyst (Slate + AppSail)

Slate hosts the **React/Vite frontend**. AppSail hosts the **FastAPI backend**.
Slate cannot run Python.

## A. Slate (frontend) — LIVE

**App URL:** `https://yukti-exuqctrg.onslate.in`  
Smoke-tested: HTTP 200.

Build console:  
`https://console.catalyst.zoho.in/baas/60080072056/project/49924000000013048/Development#/slate/app/7978000000005001/deployment/7978000000005003/overview`

### CLI redeploy (India DC)

From repo root (CLI logged in):

```powershell
catalyst deploy slate yukti -m "your message"
```

Requires `.catalyst/slate-config.toml`, `catalyst.json` slate source `"."`, `.catalystrc`, and `.env` with:

```
VITE_API_BASE_URL=https://yukti-api-50044348137.development.catalystappsail.in
```

`.catalystignore` must exclude `backend/`, `appsail-stage/`, `node_modules/`, `*.db`, zip backups, etc.  
**Note:** Catalyst CLI 1.27.0 Slate pack does not read `.catalystignore` by default (unlike AppSail). This machine’s CLI was patched to honor it; without that patch, pack includes ~700MB+ of backend and appears to hang after listing apps.

| Field | Value |
|-------|--------|
| Framework | React + Vite (`react-vite`) |
| Node runtime | Node 20 (build image may use 22) |
| Root path | `./` |
| Install command | `npm install` |
| Build command | `npm run build` |
| Output path | `dist` |

### Environment variables

Baked into the Slate build via `.env` in the upload. Also keep in console / `slate-config.toml`:

```
VITE_API_BASE_URL=https://yukti-api-50044348137.development.catalystappsail.in
```

First-time CLI create rejected `env_variables` in TOML (`INVALID_INPUT`); subsequent deploys skip re-uploading config when the CLI app already exists.

## B. AppSail (backend) — LIVE

**URL:** `https://yukti-api-50044348137.development.catalystappsail.in`

Verified: `/api/health` 200, `/api/ready` snapshots true, `/api/bootstrap` 200.

Redeploy from repo root (CLI logged in to India DC):

```powershell
# Rebuild Linux deps into appsail-stage/lib (required — Windows wheels will 503 on AppSail)
# then:
catalyst deploy --only appsail
```

Staging folder `appsail-stage/` ships slim serve deps + precomputed `yukti.db` (avoids EMFILE from full ML stack).

### Startup contract

AppSail injects `X_ZOHO_CATALYST_LISTEN_PORT`. `catalyst_start.py` binds:

`0.0.0.0:$X_ZOHO_CATALYST_LISTEN_PORT`

## C. Wire UI → API

1. Ensure `.env` / Slate env has `VITE_API_BASE_URL` (no trailing slash).  
2. Redeploy Slate (`catalyst deploy slate yukti -m "..."`).  
3. Open Slate URL → platform should load `/api/bootstrap` from AppSail.

## D. Verify

- `GET https://yukti-api-50044348137.development.catalystappsail.in/api/health` → `{ success: true }`  
- `GET https://yukti-api-50044348137.development.catalystappsail.in/api/ready` → `snapshots: true`  
- `GET https://yukti-exuqctrg.onslate.in` → HTTP 200  
- Slate Network tab: `/api/bootstrap` status 200  

## Local AppSail-like run

```powershell
cd backend
$env:PYTHONPATH = (Get-Location).Path
$env:DATABASE_URL = "sqlite:///./yukti.db"
$env:X_ZOHO_CATALYST_LISTEN_PORT = "9000"
python catalyst_start.py
```

## E. Linux wheels + staging (AppSail)

AppSail is Linux. Installing wheels on Windows into `backend/lib/` will 503 at runtime.

Preferred path used here:

1. Build a slim stage under `appsail-stage/` (serve deps + precomputed `yukti.db`).
2. Point `catalyst.json` → `"source": "appsail-stage"`.
3. `catalyst_start.py` skips seed/nightly when bootstrap snapshots already exist (lazy-imports heavy ML only on rebuild).

## F. Slate pack ignore patch

Catalyst CLI 1.27.0 Slate pack does **not** honor `.catalystignore` (AppSail does). After installing the CLI:

```powershell
node scripts/patch-slate-pack-ignore.js
```

Without the patch, `catalyst deploy slate yukti` packs `backend/` / stage zips (~700MB+) and appears to hang.

## G. Frontend notes

See [FRONTEND.md](./FRONTEND.md) for `VITE_API_BASE_URL`, bootstrap hydration (`dataEpoch`), and the MOD-02 graph viz fix (centrality core cap so large AppSail graphs still paint).
