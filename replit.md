# SmartCity OS

## Overview

pnpm workspace monorepo with two React+Vite apps that share a common design system, plus an Express API backing real Claude streaming chat.

## Artifacts

- **artifacts/design-tools** — `/` — Revit Workbench. Lists snapshots from the API and lets users chat with Claude about a selected snapshot. Includes Style Probe, API Health, and stub project pages.
- **artifacts/plan-review** — `/plan-review/` — Plan-review console. Visual shell with mock data: 12 submittals, 18 findings, KPI tiles, AI Reviewer side panel, Submittal Detail, Findings Library, Code Library, Style Probe.
- **artifacts/api-server** — `/api/*` — Express + Pino. Routes:
  - `GET  /api/healthz`
  - `GET  /api/snapshots` — list (id, projectName, receivedAt)
  - `GET  /api/snapshots/:id` — full payload
  - `POST /api/snapshots` — guarded by `X-Snapshot-Secret` header (matched against `SNAPSHOT_SECRET` env var). In-memory store, no DB.
  - `POST /api/chat` — SSE stream `data: {text:"..."}\n\n` terminated by `data: [DONE]\n\n`. Uses Anthropic SDK via `@workspace/integrations-anthropic-ai` with model `claude-sonnet-4-5`.
- **artifacts/mockup-sandbox** — design exploration sandbox.

## Shared Libraries

- `lib/portal-ui` (`@workspace/portal-ui`) — design system. Exports components (DashboardLayout, Sidebar, Header, etc.), `initTheme`, and styles. Two style entrypoints:
  - `@workspace/portal-ui/styles` — base `.sc-*` classes for both apps
  - `@workspace/portal-ui/styles/plan-review-disciplines.css` — discipline badge palette (plan-review only)
- `lib/api-client-react` (`@workspace/api-client-react`) — Orval-generated React Query hooks (`useHealthCheck`, `useListSnapshots`, `useGetSnapshot`, `useCreateSnapshot`). `/api/chat` SSE is consumed via raw `fetch` + `ReadableStream` parser in `artifacts/design-tools/src/store/snapshots.ts` (Zustand).
- `lib/api-zod`, `lib/api-spec`, `lib/integrations-anthropic-ai`, `lib/integrations-base`, `lib/db`.

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- Express 5, Pino, Zod (`zod/v4`)
- React 18 + Vite 7, TanStack Query, Zustand, Wouter, Tailwind, Lucide
- Anthropic SDK (proxied via Replit AI Integrations)
- Orval for API codegen, esbuild for server bundle

## Environment

- `SNAPSHOT_SECRET` — required for non-dev. In dev, a temporary secret is generated for the process and a generic warning is logged (the value is **never** logged).
- AI integration credentials provided by Replit AI Integrations.

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build all
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks and Zod from OpenAPI
- `pnpm --filter <pkg> run dev` — start any artifact
