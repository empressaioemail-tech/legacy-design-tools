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
