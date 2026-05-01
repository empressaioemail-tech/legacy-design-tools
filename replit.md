# SmartCity OS

## Overview

pnpm workspace monorepo with two React+Vite apps that share a common design system, plus an Express API backed by Postgres (Drizzle) with real Claude streaming chat.

## Domain Model (Wave 1)

- **Engagement** — top-level concept. One per real project (Seguin Residence, Snowdon Towers, etc.). Has name, jurisdiction, address, status (`active|on_hold|archived`), `nameLower` (for case-insensitive matching), timestamps. Persisted in Postgres.
- **Snapshot** — child of an engagement. Each Revit `POST /api/snapshots` creates one row holding the full JSON payload plus derived counts (sheets/rooms/levels/walls). Belongs to exactly one engagement.
- **Auto-create**: if a snapshot arrives with a `projectName` that does not match any existing engagement (case-insensitive), the API transactionally creates a new engagement first, then attaches the snapshot. The Revit add-in keeps working unchanged.

## Artifacts

- **artifacts/design-tools** — `/` — Engagements workspace.
  - `/` engagement list (cards with KPI counts from latest snapshot, status pill, refetch every 5s)
  - `/engagements/:id` engagement detail (KPI strip + snapshot timeline + raw JSON viewer + Claude chat in right panel)
  - `/style-probe`, `/health` for dev
- **artifacts/plan-review** — `/plan-review/` — Plan-review console (mostly mock data). The "Sheets" nav entry (`/plan-review/sheets`) lists real Revit snapshots and renders sheet cards with a "First ingested" chip backed by `sheet.created` history events via `GET /api/atoms/sheet/{id}/summary`. Legacy rows render "Not tracked".
- **artifacts/api-server** — `/api/*` — Express + Pino + Drizzle:
  - `GET  /api/healthz`
  - `GET  /api/engagements` — list with `snapshotCount` + `latestSnapshot` summary
  - `GET  /api/engagements/:id` — engagement + full snapshot list
  - `GET  /api/snapshots` / `GET /api/snapshots/:id` — kept for back-compat
  - `POST /api/snapshots` — guarded by `X-Snapshot-Secret`. Returns `{id, receivedAt, engagementId, engagementName, autoCreated}`. Handles `walls.count` or `walls[]` shapes.
  - `POST /api/chat` — SSE stream. Body: `{engagementId, question, history}`. Looks up engagement + latest snapshot; returns 400 `{error:"no_snapshots"}` if none. Model `claude-sonnet-4-5` via `@workspace/integrations-anthropic-ai`.
  - `GET  /api/atoms/:slug/:id/summary` — empressa-atom `contextSummary` for a single atom. Returns `{prose, typed, keyMetrics, relatedAtoms, historyProvenance:{latestEventId, latestEventAt}, scopeFiltered}`. `latestEventId === ""` is the "no events yet" sentinel.
  - `POST /api/storage/uploads/request-url` — returns `{uploadURL, objectPath, metadata}` for the presigned-PUT flow (avatar uploads). Bytes go directly to GCS.
  - `GET  /api/storage/objects/*` — serves uploaded object entities (avatar images, etc.).
  - `GET  /api/storage/public-objects/*` — serves public assets from `PUBLIC_OBJECT_SEARCH_PATHS`.
- **artifacts/mockup-sandbox** — design exploration sandbox.

## Shared Libraries

- `lib/portal-ui` (`@workspace/portal-ui`) — design system. `DashboardLayout`, `Sidebar`, `Header`, `initTheme`, two style entrypoints.
- `lib/api-client-react` — Orval-generated React Query hooks: `useListEngagements`, `useGetEngagement`, `useListSnapshots`, `useGetSnapshot`, `useCreateSnapshot`, `useHealthCheck`. SSE chat is consumed via raw `fetch` + `ReadableStream` in `artifacts/design-tools/src/store/engagements.ts` (Zustand UI state only — server data lives in React Query).
- `lib/api-spec` — OpenAPI source of truth.
- `lib/api-zod` — generated Zod schemas.
- `lib/db` (`@workspace/db`) — Drizzle schema (`engagements`, `snapshots`), `drizzle-orm/node-postgres` with TCP `pg.Pool`. Scripts: `push`, `seed` (idempotent, onConflictDoNothing on `nameLower`).
- `lib/integrations-anthropic-ai`, `lib/integrations-base`.
- `lib/object-storage-web` (`@workspace/object-storage-web`) — browser upload helpers (`useUpload` hook, `ObjectUploader` Uppy modal). Wraps the presigned-URL flow against `/api/storage/uploads/request-url`.
- `lib/adapters` (`@workspace/adapters`) — DA-PI-4 + DA-PI-2. Federal + state + local site-context adapters for the Empressa pilots. Federal tier (DA-PI-2): FEMA NFHL flood zones, USGS NED elevation (EPQS point query), EPA EJScreen block-group indicators, and FCC National Broadband Map availability — all gate on `jurisdiction.stateKey !== null` so they apply for any pilot state. State tier (Utah/UGRC, Idaho/INSIDE Idaho, Texas/TCEQ) and local tier (Grand County UT, Lemhi County ID, Bastrop TX) gate on the resolved local/state key. Exports `ALL_ADAPTERS` (federal first, then state, then local), a synchronous `runAdapters` runner with per-adapter timeout + `AdapterRunError` failure isolation, a `resolveJurisdiction` helper that scans `engagements.jurisdiction_city` / `jurisdiction_state` / freeform `jurisdiction` / `address`, and a per-jurisdiction setback table loader (`local/setbacks/*.json`). The runner emits `AdapterRunOutcome[]` with `tier` + `status` (`ok` | `no-coverage` | `failed`) consumed by `POST /api/engagements/:id/generate-layers`, which persists OK rows as `briefing_sources` (sourceKind `federal-adapter` / `state-adapter` / `local-adapter`) under the same supersession contract as the manual-upload path. The Site Context tab groups sources by tier (federal / state / local / manual) and exposes a "Generate Layers" button that calls the new endpoint. Task #180: the runner accepts an optional `AdapterResultCache` (interface in `cache.ts`) keyed on `(adapterKey, lat/lng rounded to 5 decimals)`. Cache hits skip the network and replay the cached `AdapterResult` envelope verbatim; failures are never cached. The api-server wires a Postgres-backed implementation (`adapter_response_cache` table, default TTL 24h, configurable via `ADAPTER_CACHE_TTL_MS`; set to `0` to disable) so re-runs of generate-layers against the same parcel skip slow / rate-limited federal feeds.

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- Express 5, Pino, Zod (`zod/v4`), Drizzle ORM, node-postgres
- React 18 + Vite 7, TanStack Query, Zustand, Wouter, Tailwind, Lucide
- Anthropic SDK (proxied via Replit AI Integrations)
- Orval for API codegen, esbuild for server bundle, tsx for seed scripts

## Environment

- `SNAPSHOT_SECRET` — required for non-dev. In dev, a temporary secret is generated for the process and a generic warning is logged (the value is **never** logged).
- `DATABASE_URL` — Replit-managed Postgres. Used by Drizzle.
- `TEST_DATABASE_URL` — optional; falls back to `DATABASE_URL`. Lib integration tests use a per-run schema named `test_<unix_ts>_<rand8hex>` and drop it on completion. A reaper drops `test_*` schemas older than 1h (cap 50/pass).
- `MUNICODE_MIN_GAP_MS` / `MUNICODE_JITTER_MAX_MS` — optional rate-limit overrides for the municode HTTP client (used in tests to avoid sleeping). Defaults preserve production behavior.
- AI integration credentials provided by Replit AI Integrations.

## End-to-End Tests

- `artifacts/design-tools` ships a Playwright suite under `e2e/` (config: `playwright.config.ts`). Run with `pnpm --filter @workspace/design-tools run test:e2e`. The suite is excluded from Vitest (`vitest.config` only matches `src/**/*.test.{ts,tsx}`).
- `e2e/submission-detail.spec.ts` pins the submission-detail modal flow: seeds an isolated engagement via `@workspace/db`, ingests a submission via `POST /api/engagements/:id/submissions` (which fires `engagement.submitted`), navigates to `/engagements/<id>?tab=submissions`, opens the row, asserts the modal note, the "Submitted to <jurisdiction>" header, and the `engagement.submitted` event panel; closes and re-opens to verify idempotency. The engagement is deleted in `afterAll` (FK cascades to submissions).
- The config auto-discovers `mesa-libgbm-*` in `/nix/store` and prepends its `lib/` dir to `LD_LIBRARY_PATH` so the bundled `chrome-headless-shell` can resolve `libgbm.so.1` on Replit's NixOS image without per-developer setup. Other store paths that ship the same soname are deliberately ignored (some bundle older `libstdc++.so.6` and would shadow the system one and break Node).
- The suite is self-orchestrating: `playwright.config.ts` declares a `webServer` block that spawns the API Server (`PORT=8080`) and design-tools (`PORT=20295`, `BASE_PATH=/`) when they are not already responding through `localhost:80`. With `reuseExistingServer: true`, an active workflow is reused and nothing is spawned. Override with `E2E_BASE_URL` to point at a different environment (this also suppresses the spawn).
- `pnpm --filter @workspace/design-tools run test:e2e` runs `playwright install chromium` first (idempotent), so the suite is a one-command invocation in a fresh sandbox.

## CI / Pre-merge validation

- Pre-merge gating runs through Replit's validation mechanism, not GitHub Actions. Three named commands are registered: `typecheck` (`pnpm run typecheck`), `test` (`pnpm run test`), `e2e` (`pnpm --filter @workspace/design-tools run test:e2e`). They run together on every `mark_task_complete`; a failure in any one blocks the merge. See `TESTING.md` § "CI — Replit pre-merge validation" for details, including the wall-clock budget (~2 min total, run in parallel).

## Testing (Sprint H01 Part 1)

- Per-package Vitest with v8 coverage in `lib/db`, `lib/codes`, `lib/codes-sources`. Root: `pnpm test` runs all three.
- `lib/codes` and `lib/codes-sources`: pure unit tests with mocked HTTP/OpenAI/DB. No live network.
- `lib/db`: Postgres integration tests. `withTestSchema()` creates an isolated schema, replays `lib/db/src/__tests__/__fixtures__/schema.sql.template` (sed-rewritten from a real `pg_dump`), runs the test, then drops the schema.
- After any drizzle-kit push that changes tables/columns/FKs, refresh the fixture: `pnpm --filter @workspace/db run test:fixture:schema`. The script strips pg_dump preamble and rewrites `public.` → `@@SCHEMA@@.`, but preserves `public.vector(...)` because pgvector's type lives in the public schema.
- Refactors landed for testability: extracted `parseDesignCriteriaHtml`, `chunkByHeader`, `parseSectionResponse`, `contentHash`; added test-only resets `__resetMunicodeClientStateForTesting` / `__setRateLimitOverridesForTesting`.
- Out of scope (Part 2): orchestrator + queue tests, prompt formatter (if extracted), api-server route tests, frontend tests, CI, coverage thresholds. See `TESTS_DEFERRED.md`.

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build all
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks and Zod from OpenAPI
- `pnpm --filter @workspace/db run push` — push Drizzle schema to Postgres
- `pnpm --filter @workspace/db run seed` — idempotent seed (Seguin + Musgrave)
- `pnpm --filter <pkg> run dev` — start any artifact

## DA-PI-3 — Briefing engine

- `lib/briefing-engine` is the workspace lib that synthesizes the seven-section A–G site briefing (Spec 51 §2). `generateBriefing()` takes the engagement's current `briefing_sources`, groups them by category, builds the prompt, and either returns a deterministic `mockGenerator` payload (default) or calls Claude Sonnet 4.5 via `@workspace/integrations-anthropic-ai` (when `BRIEFING_LLM_MODE=anthropic`). Unresolved citation tokens (`{{atom|briefing-source|<id>|<label>}}`, `[[CODE:<atomId>]]`) are stripped and reported via `invalidCitations`.
- `parcel_briefings` carries `section_a..g`, `generated_at`, `generated_by`, plus `prior_section_*` / `prior_generated_*` backup columns that the route copies the previous narrative into on regenerate, all in one transaction.
- API: `POST /api/engagements/:id/briefing/generate` returns 202 + `generationId` and runs the engine fire-and-forget; `GET /api/engagements/:id/briefing/status` reports the in-process job state (idle/pending/completed/failed). The persisted briefing on `GET /briefing` is the source of truth.
- Events: `parcel-briefing.generated` (first run) / `parcel-briefing.regenerated` (subsequent) appended best-effort. The route also emits one `materializable-element.identified` event per requirement extracted from sections C/D/F (DA-PI-5) — entityId is `materializable-element:{briefingId}:{section}:{index}`, payload carries the section letter, index, and claim text.
- UI: the Site Context tab renders an A–G section card stack (A always expanded, B+E auto-expanded when non-empty, C/D/F/G collapsed) plus a "Generate Briefing" / "Regenerate Briefing" button that polls status every ~2s while pending and re-fetches the briefing read on completion.

## One-off Maintenance Scripts

- **Sweep orphaned avatar files** — `pnpm --filter @workspace/scripts run sweep:orphan-avatars`. Lists every object under `<PRIVATE_OBJECT_DIR>/uploads/` in the private bucket, cross-references against live `users.avatar_url` values, and reports the unreferenced ones. Runs in dry-run mode by default and only prints what *would* be deleted; pass `-- --apply` to actually delete (e.g. `pnpm --filter @workspace/scripts run sweep:orphan-avatars -- --apply`). Use this once after the avatar-cleanup fix from Task #90 to clear out the historical backlog of orphans; the api-server now deletes the prior object on every replace/clear, so repeated runs should report zero orphans.
- **Smoke-test the live DXF→glb converter** — `pnpm --filter @workspace/scripts run smoke:converter`. Reads `CONVERTER_URL` and `CONVERTER_SHARED_SECRET` from env, posts a tiny DXF fixture for each of the seven Spec 52 §2 layer kinds, and validates the response is a binary glTF (header `glTF\0`, JSON+BIN chunks, byteLength matches). Optional `--fixture-dir <dir>` to use real per-layer fixtures (`<dir>/<layerKind>.dxf`); otherwise falls back to a minimal DXF with a warning. Exits non-zero if any variant fails.

## DXF→glb Converter (Spec 52)

- Dev default: `DXF_CONVERTER_MODE=mock` — in-process mock client returns a stub glb. No external dependency.
- Production: when `DXF_CONVERTER_MODE=http` the api-server selects `HttpConverterClient`, which signs each request with HMAC-SHA256 over `${requestId}.${layerKind}` using `CONVERTER_SHARED_SECRET` and posts a multipart body (`dxf` blob + `layerKind`) to `CONVERTER_URL`. Built-in retry/backoff: 2 retries (3 attempts total), 250 ms initial backoff, 2× multiplier, capped at 4000 ms; retries on network errors, timeouts, and 5xx; never retries on 4xx (`converter_rejected`), invalid content-type, or empty body. Each attempt is logged via pino with `requestId`, `layerKind`, `attempt`, `durationMs`, `byteSize`, `status`, and `code` (on failure).
- **PENDING (Task #160 follow-up #167):** Production is intentionally still on the `mock` default (no `DXF_CONVERTER_MODE` set in the production env). The flip to `http` is gated on provisioning the production secrets `CONVERTER_URL` and `CONVERTER_SHARED_SECRET` — without them, `validateConverterEnvAtBoot` would hard-fail. Once the secrets are in place via the secrets pane, set `DXF_CONVERTER_MODE=http` in the production env and run `pnpm --filter @workspace/scripts run smoke:converter` to verify schema parity per layer kind before publishing.
