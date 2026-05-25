# Local dev on Windows (cente workstation)

Run the **current Cortex pipeline** locally: Neon DB → api-server on **:8080** → design-tools on **:20295** → BIM GLB viewer + Studio/mnml renders.

This is the supported path. Do **not** use `pnpm --filter @workspace/api-server run dev` (Cloud Run proxy) unless you intentionally want prod API behavior without local Canva routes.

---

## Architecture (one page)

```
Browser  http://localhost:20295
    │  Vite proxy  /api/*  →  http://127.0.0.1:8080
    ▼
api-server  dev:local  (Node, built dist/index.mjs)
    ├── DATABASE_URL        → Neon (engagements, BIM model, renders rows)
    ├── GOOGLE_APPLICATION_CREDENTIALS  → GCS (GLB bytes, sheets, render mirrors)
    └── MNML_RENDER_MODE=mock (default) or http + MNML_API_* for real stills
```

| Surface | Tab | Needs |
|---------|-----|--------|
| Engagement list, snapshots metadata | Model / Dashboard | `DATABASE_URL` |
| **3D BIM viewer** (GLB) | Model → Snapshots | DB + **GCS** (`PRIVATE_OBJECT_DIR`, ADC) |
| **Studio stills** | Deliver → Studio | DB + GCS for capture; mnml mock or live key |
| Plan review modal BIM | Review | Same as Snapshots viewer |

**Symptom cheat sheet**

| What you see | Likely cause |
|--------------|----------------|
| Projects load, GLB **HTTP 500** | GCS creds missing — api using Replit sidecar path |
| Empty gray viewer, no HUD | GLB 500 or zero-height canvas — fix GCS first |
| `engagement_not_found` in curl | Wrong Neon branch / empty DB |
| Cursor shows model, Chrome 500 | Chrome hit fresh 500; Cursor had cached GLB — fix API, hard refresh Chrome |

---

## One-time setup

### 1. Install deps

```powershell
cd P:\legacy-design-tools
pnpm install
```

### 2. Create `.env.local` (gitignored)

```powershell
copy .env.local.example .env.local
notepad .env.local
```

**Required**

```env
DATABASE_URL=postgresql://...@....neon.tech/...?sslmode=require
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json
PRIVATE_OBJECT_DIR=/legacy-design-tools-prod-objects/.private
PUBLIC_OBJECT_SEARCH_PATHS=/legacy-design-tools-prod-objects/public
```

Scripts also default the GCS paths and key path when the key file exists; still commit these to `.env.local` so a **new PowerShell window** for api-server inherits them.

### 3. Schema (once per DB, or after migrations on main)

```powershell
cd P:\legacy-design-tools\lib\db
pnpm run push
```

### 4. Optional — real mnml stills (Studio)

Default local api boots with **mock** mnml (placeholder images). For real `POST /api/engagements/:id/renders`:

```env
MNML_RENDER_MODE=http
MNML_API_URL=https://api.mnmlai.dev
MNML_API_KEY=<your key>
```

---

## Daily start (recommended)

From repo root:

```powershell
cd P:\legacy-design-tools
.\scripts\dev-local-windows.ps1
```

- Opens **api-server** in a new PowerShell window (`dev:local` on :8080).
- Runs **Vite** in the current window (:20295).

Open **http://localhost:20295** in Chrome (not only Cursor preview). Hard refresh after api restart: **Ctrl+Shift+R**.

### Alternative: two terminals

```powershell
# Terminal A — API
.\scripts\start-local-stack.ps1 -ApiOnly

# Terminal B — UI
.\scripts\start-local-stack.ps1 -ViteOnly
```

---

## Verify the pipeline

After api shows “listening”:

```powershell
.\scripts\verify-local-pipeline.ps1
```

Optional — pass an engagement id that has a Revit GLB:

```powershell
.\scripts\verify-local-pipeline.ps1 -EngagementId de4315f1-0e24-4484-b475-2575428a2659
```

Manual checks:

```powershell
curl.exe -s http://127.0.0.1:8080/api/healthz
curl.exe -s http://127.0.0.1:20295/api/healthz
curl.exe -s -o NUL -w "glb:%{http_code}" http://127.0.0.1:8080/api/materializable-elements/<element-id>/glb
```

GLB should be **200**, not 500.

---

## api-server modes (do not mix)

| Command | Port | Backend | Use when |
|---------|------|---------|----------|
| `pnpm --filter @workspace/api-server run dev:local` | 8080 | Local Node + your `.env.local` | **Default** — full pipeline |
| `pnpm --filter @workspace/api-server run dev` | 8080 | Proxy → Cloud Run | Prod API only; no local Canva |

Only **one** process may listen on **8080**. If GLB behaves differently in two browsers, you still have a single api — fix env on that process, not the browser.

---

## BIM viewer + render flow (current product)

1. **Revit sync** writes rows + GLB to GCS (prod path; local reads same bucket with service account).
2. **Snapshots** loads `GET /api/engagements/:id/bim-model` then `GET /api/.../glb`.
3. **Studio** kicks `POST /api/engagements/:id/renders` → headless GLB screenshot (`bimViewportCapture`) → mnml → mirrored PNG.

Local dev validates steps 2–3 against prod storage and Neon data; it does not re-run Revit ingest.

---

## Troubleshooting

### Port already in use

```powershell
Get-NetTCPConnection -LocalPort 8080,20295 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

Then restart scripts.

### GLB load fails (HTTP 500 or 403 in the Model viewer)

The api-server is up (`/api/healthz` → 200) but `GET /api/.../glb` fails when the **service account in `GOOGLE_APPLICATION_CREDENTIALS` cannot read** `gs://legacy-design-tools-prod-objects`.

Typical log line:

```text
smartcity-agent@smartcity-os-prod.iam.gserviceaccount.com does not have storage.objects.get ...
```

**Fix (pick one):**

1. **Use the Design Tools runtime key** (if you have it): point `GOOGLE_APPLICATION_CREDENTIALS` in `.env.local` at `api-server-runtime@legacy-design-tools-prod.iam.gserviceaccount.com` JSON, then restart api-server.
2. **Grant the existing key read access** (project admin):

```powershell
gcloud storage buckets add-iam-policy-binding gs://legacy-design-tools-prod-objects `
  --member="serviceAccount:smartcity-agent@smartcity-os-prod.iam.gserviceaccount.com" `
  --role="roles/storage.objectViewer" `
  --project=legacy-design-tools-prod
```

Then restart api-server (`dev:local` window) and hard-refresh the browser.

Verify:

```powershell
.\scripts\verify-local-pipeline.ps1 -EngagementId <uuid>
```

GLB must be **200**, not 403/500.

### api rebuild after pulling main

```powershell
pnpm --filter @workspace/api-server run build
```

`dev:local` always builds then starts.

### Typecheck before push

```powershell
cd P:\legacy-design-tools
pnpm run typecheck
```

---

## Workstation note (AGENTS.md)

**cente** — gcloud: `C:\Users\cente\google-cloud-sdk\bin\gcloud.cmd`, key: `C:\Users\cente\google-cloud-sdk\smartcity-agent-key.json`.
