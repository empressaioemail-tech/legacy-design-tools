# Canva Connect (api-server)

## Local stack (not Cloud Run proxy)

Use **`pnpm run dev:local`** (or `scripts/dev-local-windows.ps1`) so `/api/canva/*` is served from this repo’s `dist/index.mjs` on port 8080.

| Mode | Command | Behavior |
|------|---------|----------|
| Proxy | `pnpm run dev` | `dev-proxy.mjs` → Cloud Run — **no local Canva routes** |
| Local | `pnpm run dev:local` | Build + `DATABASE_URL` + all routes including Canva |

Quick check after boot:

```powershell
curl http://localhost:8080/api/canva/connection
# {"state":"disconnected"} from local server (not [dev-proxy] logs)
```

## Environment variables

| Variable | Example | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://...` | Required for `dev:local` |
| `CANVA_CLIENT_ID` | Developer Portal | OAuth client id |
| `CANVA_CLIENT_SECRET` | (secret) | OAuth client secret |
| `CANVA_REDIRECT_URI` | `http://localhost:8080/api/canva/oauth/callback` | Must match Developer Portal redirect URL **exactly** |
| `CANVA_OAUTH_SUCCESS_URL` | `http://localhost:20295/` | Browser redirect after successful connect |
| `PORT` | `8080` | api-server listen port |
| `NODE_ENV` | `development` | Enables dev session + `dev-connect` when Canva env unset |

Register redirect URL in the [Canva Developer Portal](https://www.canva.com/developers/) → your integration → Authentication:

`http://localhost:8080/api/canva/oauth/callback`

## OAuth scopes (enable in Developer Portal)

Space-separated in authorize URL; integration settings must include all of:

- `asset:read` `asset:write`
- `brandtemplate:content:read` `brandtemplate:meta:read`
- `design:content:read` `design:content:write`
- `design:meta:read`
- `profile:read`

Brand template autofill requires **Canva Enterprise** for the connecting user.

## Database

Apply Canva tables before first connect/push:

```powershell
cd P:\legacy-design-tools\lib\db
pnpm run push   # includes drizzle/0020_add_canva.sql
```

## Frontend

- design-tools uses live API by default (`artifacts/design-tools/src/lib/canvaService.ts`).
- Do **not** set `VITE_CANVA_API=0` for real OAuth QA (that forces the mock).
- Vite proxies `/api` → `http://localhost:8080`.

## Connect flow

1. UI: **Connect Canva account** → `POST /api/canva/oauth/start` → `{ url }` → browser navigates to Canva.
2. User approves → Canva redirects to `GET /api/canva/oauth/callback?code=...&state=...`
3. Server exchanges code (PKCE), stores tokens in `canva_connections`, redirects to `CANVA_OAUTH_SUCCESS_URL?canva=connected`
4. Client Materials tab strips `?canva=connected` and refreshes `GET /api/canva/connection`

**Dev fallback:** If `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` are unset, `oauth/start` returns **503** and the UI calls `POST /api/canva/oauth/dev-connect` (non-production only). That path is **disabled** when credentials are configured.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| Connect does nothing / 404 on `/api/canva/*` | api-server on `run dev` proxy | Switch to `dev:local` |
| `503` on oauth/start | Missing `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` | Set env on api-server process, or use dev-connect fallback |
| `redirect_uri_mismatch` | Portal redirect ≠ `CANVA_REDIRECT_URI` | Match `http://localhost:8080/api/canva/oauth/callback` exactly |
| Callback 400 “Invalid state” | Stale tab / DB reset between start and callback | Click Connect again (new PKCE row) |
| Connected but templates empty / enterprise message | Non-Enterprise account | Enterprise + brand templates in Canva |
| Push fails `auth` | Token expired | Disconnect → Connect again |
| Still “disconnected” after OAuth | Wrong API host (proxy) or `VITE_CANVA_API=0` | Local api-server + default canvaService |

## Disconnect

`DELETE /api/canva/connection` — removes row for current session owner.
