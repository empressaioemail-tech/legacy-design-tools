# cc-agent-C — Codex Reviewer QA local dev handoff

**Date:** 2026-07-01  
**Workstation:** `cente` / `P:\legacy-design-tools`  
**Agent:** cc-agent-C (Cursor)  
**Status:** Local dev verified working on cente; **code fixes uncommitted** on `main` (see Files changed).

---

## Summary

Operator could not load the tile workspace — white screen at `http://localhost:19592/codex-reviewer-qa/`. Root cause was a **browser crash** (`Buffer is not defined`) from importing the full `@workspace/portal-ui` barrel, which pulled Postgres client code into the Vite bundle. Secondary gaps: no Vite `/api` proxy on codex-reviewer-qa, no `.env.local` on cente (api-server started via Cloud Run proxy instead of `dev:local`).

After fixes below, the Plan Review tile shell renders (SpaceBar presets, Intake & Queue / Compliance Run / Letter / Map tiles). BFF calls work when api-server is listening on `:8080`.

---

## Issues encountered

| # | Symptom | Cause | Fix |
|---|---------|-------|-----|
| 1 | Nothing on `:19592` | Dev server not started | Start codex-reviewer-qa Vite (Terminal B) |
| 2 | White screen, empty `#root` | `Uncaught ReferenceError: Buffer is not defined` in browser console; barrel import `@workspace/portal-ui` → `EngineHonestyChrome` → `@workspace/engine-core` → `@workspace/db` → `postgres`/`postgres-bytea` | Import `initTheme` from `@workspace/portal-ui/theme` instead of barrel |
| 3 | Tile BFF 404 from browser | `codex-reviewer-qa/vite.config.ts` had no `/api` proxy | Added proxy to `localhost:8080` (mirror `plan-review`) |
| 4 | api-server won't `dev:local` | No `.env.local` / `DATABASE_URL` on cente | Used `pnpm --filter @workspace/api-server run dev` (Cloud Run proxy) as interim; see Full local path below |

### Console signature (before fix)

```
Module "events" has been externalized for browser compatibility...
Uncaught ReferenceError: Buffer is not defined
  at chunk-ILJ63FQC.js (postgres-bytea / pg driver prebundle)
```

### URL gotchas

| URL | Result |
|-----|--------|
| `http://localhost:19592/` | 302 → `/codex-reviewer-qa/` |
| `http://localhost:19592/codex-reviewer-qa/` | **Correct** — app entry |
| `http://localhost:19592/codex-reviewer-qa` (no trailing slash) | Vite 404 |

---

## Quick start (cente, two terminals)

### Terminal A — api-server (`:8080`)

**Option A — Cloud Run proxy (no `.env.local` required):**

```powershell
cd P:\legacy-design-tools
git pull
$env:PORT = "8080"
pnpm --filter @workspace/api-server run dev
```

Proxies to prod `cortex-api` (`dev-proxy.mjs`). Tile BFF (`/api/plan-review/*`) works against production backend.

**Option B — Full local Node + Neon (preferred when debugging ingest/DB):**

```powershell
cd P:\legacy-design-tools
copy .env.local.example .env.local
# Edit DATABASE_URL (+ GCS vars if GLB/topography needed)

Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { return }
  Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim().Trim('"').Trim("'")
}

$env:PORT = "8080"
$env:NODE_ENV = "development"
$env:PRECEDENCE_ENGINE_PRODUCTION = "1"
$env:HYDROLOGY_PYSHEDS_INSTALLED = "1"
pnpm --filter @workspace/api-server run dev:local
```

Or: `.\scripts\start-local-stack.ps1 -ApiOnly` (loads `.env.local` + GCS defaults).

**Do not use** `pnpm --filter @workspace/api-server run dev` and `dev:local` at the same time — only one listener on `:8080`.

### Terminal B — codex-reviewer-qa (`:19592`)

```powershell
cd P:\legacy-design-tools
$env:PORT = "19592"
$env:BASE_PATH = "/codex-reviewer-qa/"
pnpm --filter @workspace/codex-reviewer-qa run dev
```

Wait for:

```
VITE v7.x.x  ready in …ms
➜  Local:   http://localhost:19592/codex-reviewer-qa/
```

Open **http://localhost:19592/codex-reviewer-qa/** in Chrome (hard refresh **Ctrl+Shift+R** after api restart).

If port busy:

```powershell
netstat -ano | findstr ":19592.*LISTENING"
Stop-Process -Id <PID> -Force
```

---

## Smoke checks

```powershell
# Frontend
curl.exe -s -o NUL -w "frontend:%{http_code}" http://127.0.0.1:19592/codex-reviewer-qa/

# API direct
curl.exe -s http://127.0.0.1:8080/api/healthz

# Through Vite proxy
curl.exe -s http://127.0.0.1:19592/api/healthz

# Tile BFF admin registry
curl.exe -s http://127.0.0.1:19592/api/plan-review/admin/functions
```

Expected: frontend `200`, healthz `{"status":"ok"}`, admin functions JSON array with `precedence`, `hydrology`, etc.

---

## Code changes (uncommitted on cente `main`)

| File | Change |
|------|--------|
| `artifacts/codex-reviewer-qa/vite.config.ts` | Add `server.proxy["/api"]` → `http://localhost:${API_PORT ?? 8080}` |
| `artifacts/codex-reviewer-qa/src/main.tsx` | `import { initTheme } from "@workspace/portal-ui/theme"` (avoid barrel → db leak) |
| `lib/portal-ui/package.json` | New export: `"./theme": "./src/lib/theme.ts"` |

### Suggested commit message (when ready)

```
fix(codex-reviewer-qa): local dev — Vite /api proxy + avoid portal-ui barrel in browser

Barrel import pulled engine-core/db/postgres into the client bundle (Buffer crash / white screen).
Add /api proxy for tile BFF; expose portal-ui/theme subpath for boot-only initTheme.
```

---

## Related PR work (same session)

| PR | Branch | Outcome |
|----|--------|---------|
| [#201](https://github.com/empressaioemail-tech/legacy-design-tools/pull/201) | `arch/atom-family-conformance-backfill` | Rebased on main, CI green, **merged** |
| [#202](https://github.com/empressaioemail-tech/legacy-design-tools/pull/202) | `feat/finding-engine-formal-references` | Rebased post-#201, conflict resolve (atom-contract 1.6 vs 1.5), CI green, mergeable |

---

## Architecture (local)

```
Browser  http://localhost:19592/codex-reviewer-qa/
    │  Vite proxy  /api/*  →  http://127.0.0.1:8080
    ▼
api-server  :8080
    ├── dev:local     → local Node + DATABASE_URL (Neon)
    └── dev (proxy)   → Cloud Run cortex-api (cente default when no .env.local)
```

| Surface | Port | Command |
|---------|------|---------|
| codex-reviewer-qa | 19592 | `@workspace/codex-reviewer-qa run dev` |
| api-server | 8080 | `@workspace/api-server run dev:local` **or** `run dev` (proxy) |

See also: `docs/local-dev-windows.md` (design-tools `:20295` path; same api-server `:8080` pattern).

---

## Operator checklist

- [ ] Terminal B: Vite on `:19592` with `PORT` + `BASE_PATH` set
- [ ] Terminal A: api-server on `:8080` (proxy or dev:local)
- [ ] Browser URL includes trailing slash: `/codex-reviewer-qa/`
- [ ] Hard refresh after api restart
- [ ] DevTools console: no `Buffer is not defined`
- [ ] Optional: create `.env.local` and switch to `dev:local` for prod Neon reads from local Node

---

## Follow-ups

1. **Commit** the three-file codex-reviewer-qa / portal-ui fix to `main` (or a small PR).
2. **cente `.env.local`:** copy from `.env.local.example` with prod Neon `DATABASE_URL` if operator wants `dev:local` instead of Cloud Run proxy.
3. **Longer term:** audit other SPAs that import `@workspace/portal-ui` barrel at boot — same Buffer risk if anything pulls engine-core into client graph.
