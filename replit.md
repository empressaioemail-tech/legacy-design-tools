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
- **artifacts/plan-review** — `/plan-review/` — Plan-review console (mock data only, untouched by Wave 1).
- **artifacts/api-server** — `/api/*` — Express + Pino + Drizzle:
  - `GET  /api/healthz`
  - `GET  /api/engagements` — list with `snapshotCount` + `latestSnapshot` summary
  - `GET  /api/engagements/:id` — engagement + full snapshot list
  - `GET  /api/snapshots` / `GET /api/snapshots/:id` — kept for back-compat
  - `POST /api/snapshots` — guarded by `X-Snapshot-Secret`. Returns `{id, receivedAt, engagementId, engagementName, autoCreated}`. Handles `walls.count` or `walls[]` shapes.
  - `POST /api/chat` — SSE stream. Body: `{engagementId, question, history}`. Looks up engagement + latest snapshot; returns 400 `{error:"no_snapshots"}` if none. Model `claude-sonnet-4-5` via `@workspace/integrations-anthropic-ai`.
- **artifacts/mockup-sandbox** — design exploration sandbox.

## Shared Libraries

- `lib/portal-ui` (`@workspace/portal-ui`) — design system. `DashboardLayout`, `Sidebar`, `Header`, `initTheme`, two style entrypoints.
- `lib/api-client-react` — Orval-generated React Query hooks: `useListEngagements`, `useGetEngagement`, `useListSnapshots`, `useGetSnapshot`, `useCreateSnapshot`, `useHealthCheck`. SSE chat is consumed via raw `fetch` + `ReadableStream` in `artifacts/design-tools/src/store/engagements.ts` (Zustand UI state only — server data lives in React Query).
- `lib/api-spec` — OpenAPI source of truth.
- `lib/api-zod` — generated Zod schemas.
- `lib/db` (`@workspace/db`) — Drizzle schema (`engagements`, `snapshots`), `drizzle-orm/node-postgres` with TCP `pg.Pool`. Scripts: `push`, `seed` (idempotent, onConflictDoNothing on `nameLower`).
- `lib/integrations-anthropic-ai`, `lib/integrations-base`.

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- Express 5, Pino, Zod (`zod/v4`), Drizzle ORM, node-postgres
- React 18 + Vite 7, TanStack Query, Zustand, Wouter, Tailwind, Lucide
- Anthropic SDK (proxied via Replit AI Integrations)
- Orval for API codegen, esbuild for server bundle, tsx for seed scripts

## Environment

- `SNAPSHOT_SECRET` — required for non-dev. In dev, a temporary secret is generated for the process and a generic warning is logged (the value is **never** logged).
- `DATABASE_URL` — Replit-managed Postgres. Used by Drizzle.
- AI integration credentials provided by Replit AI Integrations.

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build all
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks and Zod from OpenAPI
- `pnpm --filter @workspace/db run push` — push Drizzle schema to Postgres
- `pnpm --filter @workspace/db run seed` — idempotent seed (Seguin + Musgrave)
- `pnpm --filter <pkg> run dev` — start any artifact
