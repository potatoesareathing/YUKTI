# Deploy YUKTI on Zoho Catalyst (Slate + AppSail)

Slate hosts the **React/Vite frontend**. AppSail hosts the **FastAPI backend**.
Slate cannot run Python.

## A. Slate (GitHub) — fill the console form

Repository: `https://github.com/potatoesareathing/YUKTI.git`

| Field | Value |
|-------|--------|
| Framework | React + Vite |
| Node runtime | Node 20 |
| Root path | `/` |
| Install command | `npm install` |
| Build command | `npm run build` |
| Output path | `dist` |
| Auto Deploy | On (`main`) |

### Environment variables (Slate)

After AppSail is live, set:

```
VITE_API_BASE_URL=https://<your-appsail-url>
```

Then **Sync Now** / redeploy Slate so the build embeds the API URL.

## B. AppSail (backend)

### Console deploy (ZIP)

1. Catalyst console → **Serverless** → **AppSail** → Deploy from Console  
2. Runtime: **Python 3.11** (or latest Python)  
3. Memory: **2048 MB**  
4. Startup command:

```text
python3 catalyst_start.py
```

5. Environment:

```text
DATABASE_URL=sqlite:///./yukti.db
AUTH_BYPASS=true
AUDIT_READS=false
ENVIRONMENT=production
CORS_ORIGINS=*
```

6. Upload a ZIP of the `backend/` folder **including installed dependencies**:

```powershell
cd backend
pip install -r requirements.txt -t ./lib
# Zip: app/, catalyst_start.py, app-config.json, requirements.txt, lib/
```

Or from CLI (with Catalyst CLI logged in):

```powershell
cd backend
catalyst deploy appsail
```

First boot runs seed + nightly snapshot publish automatically (`catalyst_start.py`).

### Startup contract

AppSail injects `X_ZOHO_CATALYST_LISTEN_PORT`. `catalyst_start.py` binds:

`0.0.0.0:$X_ZOHO_CATALYST_LISTEN_PORT`

## C. Wire UI → API

1. Copy AppSail access URL (no trailing slash).  
2. Slate → Configuration → Environment Variables → `VITE_API_BASE_URL`  
3. Redeploy Slate.  
4. Open Slate URL → platform should load `/api/bootstrap` from AppSail.

## D. Verify

- `GET https://<appsail>/api/health` → `{ success: true }`  
- `GET https://<appsail>/api/ready` → `snapshots: true`  
- Slate Network tab: `/api/bootstrap` status 200  

## Local AppSail-like run

```powershell
cd backend
$env:PYTHONPATH = (Get-Location).Path
$env:DATABASE_URL = "sqlite:///./yukti.db"
$env:X_ZOHO_CATALYST_LISTEN_PORT = "9000"
python catalyst_start.py
```
