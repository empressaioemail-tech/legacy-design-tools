# QA-ready checklist — Cockpit IA + Packages + Intake

**Date:** 2026-05-24  
**Worktree:** `P:\ldt-replit-ui`  
**Branch:** `replit/ui-cockpit-ia-consolidation`  
**Production surface:** `https://prompt-agent-accelerator.replit.app/` (Architect)

**Definition of “real QA”:** merged to `main`, deployed to Cloud Run/Replit, deployment DB migrated, API routes live — not local Vite + dev-proxy to production read-only API.

Orchestrator merges via GitHub UI. Agents push branches; do not merge PRs locally.

---

## 1. Branch-complete (before opening PR)

Use this gate before asking for review or merge.

### Code hygiene

- [ ] All intended work **committed** on `replit/ui-cockpit-ia-consolidation` (no stray WIP in `P:\legacy-design-tools` for this sprint)
- [ ] `pnpm install` if workspace packages changed since last fetch/rebase
- [ ] **`pnpm run typecheck`** passes (same command CI uses)
- [ ] Design-tools dev boots cleanly: `PORT=20296 BASE_PATH=/ pnpm --filter @workspace/design-tools run dev`
- [ ] No JSX/build errors in touched files (SiteTab, SiteContextTab, InboxActionQueue, etc.)

### Automated tests (minimum bar)

```powershell
cd P:\ldt-replit-ui

pnpm run typecheck

cd artifacts\api-server
pnpm exec vitest run src/__tests__/packages.logic.test.ts

cd ..\design-tools
pnpm exec vitest run src/pages/__tests__/EngagementDetail.test.tsx
pnpm exec vitest run src/pages/__tests__/SiteContextTab.test.tsx
pnpm exec vitest run src/pages/__tests__/SiteContextBriefingProgress.test.tsx

cd ..\..\lib\portal-ui
pnpm exec vitest run src/components/__tests__/FindingDetailPanel.test.tsx
pnpm exec vitest run src/components/__tests__/BimModelViewport.test.tsx
```

- [ ] All of the above pass (expand if CI fails on other artifacts)

### Spec / codegen (packages + intake)

- [ ] `lib/api-spec/openapi.yaml` includes:
  - [ ] `POST /engagements` (intake create)
  - [ ] Package CRUD + share routes under `/engagements/{id}/packages`
  - [ ] `ClientBrief` (or equivalent) on `EngagementDetail` if exposed to FE
- [ ] `pnpm --filter @workspace/api-spec codegen` run after spec edits
- [ ] No hand-maintained drift in `packagesApi.ts` that codegen should own (or document why manual fetch remains)

### Database / fixture (required for packages PR)

- [ ] Drizzle schema: `lib/db/src/schema/engagementPackages.ts` exported from `schema/index.ts`
- [ ] Schema pushed to **deployment** Neon branch (not only local)
- [ ] `lib/db` → `pnpm db:push:test` then `pnpm db:dump:test-fixture` if this PR is the **last schema PR** in the cascade (see §4)
- [ ] CI fixture drift test passes locally if you refreshed the template

---

## 2. Suggested PR split (orchestrator decides)

Smallest blast radius first. Schema before UI that depends on it.

| PR | Scope | Merge order |
|----|--------|-------------|
| **A — IA consolidation** | `engagementViews`, Site Map / Property Intel split, dashboard + inbox grid, findings code popup, view cube, URL redirects | 1 (can ship alone for navigation QA) |
| **B — Packages platform** | `engagement_packages` tables, API routes, Packages tab, share viewer `/share/:token`, publisher ZIP export | 2 (**keystone** for deliver workflows) |
| **C — Intake + client brief** | Expanded `ClientIntakeModal`, `POST /engagements`, Client brief card on Property Intel | 3 (after or with B) |

Single PR is fine if review bandwidth allows; split if CI or schema review needs isolation.

**Do not mix** unrelated `P:\legacy-design-tools` openapi/render drift into these PRs unless explicitly coordinated.

---

## 3. Deploy-live gates (before you run production QA)

After merge to `main` and production deploy:

### Infrastructure

- [ ] Cloud Run (or Replit) image includes **api-server + design-tools** build from merged `main`
- [ ] `DATABASE_URL` on deployment has new tables (`engagement_packages`, `package_shares`, `package_share_comments`)
- [ ] No dev-proxy in production — browser hits real `/api/*` on same host

### API smoke (curl or Health page)

Replace `{BASE}` with production origin (e.g. `https://prompt-agent-accelerator.replit.app`).

- [ ] `GET {BASE}/api/healthz` → `200` + `"status":"ok"`
- [ ] `POST {BASE}/api/engagements` with `{"name":"QA smoke"}` → **201** + `id` (not 404)
- [ ] `GET {BASE}/api/engagements/{id}` → includes `clientBrief` when intake captured client fields
- [ ] `POST {BASE}/api/engagements/{id}/packages` → **201** with template body
- [ ] `GET {BASE}/api/engagements/{id}/packages` → lists created package

### Known partial after deploy (label in QA notes)

| Feature | Production expectation |
|---------|------------------------|
| Intake agent extract | **Mock** (~600ms); manual fields + review are real |
| Package asset selection ↔ API | May still use **localStorage** in publisher UI until synced |
| Share viewer | Functional token route; not full sheet-thumbnail experience |
| OpenAPI clients for packages | May still use `packagesApi.ts` until codegen merged |
| Canva | Replaced by HTML export for client-presentation template |

---

## 4. Merge cascade (from AGENTS.md)

When multiple schema PRs land:

1. Merge **smallest blast radius** first.
2. Schema-introducing PRs in **dependency order** (packages before intake if intake reads package-only fields).
3. **Re-rebase** stacked branches onto `origin/main` after keystone merges.
4. Branch that merges **last** among schema PRs owns **fixture template refresh** (`db:push:test` + `db:dump:test-fixture`).

Codegen conflicts in `lib/api-zod/src/generated/` or `lib/api-client-react/src/generated/`: hand-merge **openapi.yaml only**, then `pnpm --filter @workspace/api-spec codegen`.

---

## 5. Production QA script (human checklist)

Run on **deployed** Architect URL. Record pass/fail + screenshot or note.

### Dashboard & inbox

- [ ] Dashboard loads without excessive scroll to reach Code library
- [ ] Inbox + Projects use compact grid layout
- [ ] **Start a project** opens intake modal

### Start project (intake)

- [ ] Step 1: project name, address, client/firm, email, notes editable
- [ ] Step 1: source tabs (link / file / paste / email) optional alongside details
- [ ] Step 2: all fields editable on review screen
- [ ] **Confirm & create engagement** succeeds (no 404/500)
- [ ] Lands on engagement (Property Intel or expected post-create route)

### Engagement IA (header + segments)

- [ ] Top views: Site, Model, Deliver, Studio, Review, Settings
- [ ] Site → **Map** and **Property Intel** segments both reachable
- [ ] Legacy URLs redirect: `?tab=site-context` → Property Intel; old publish tabs → Packages where mapped

### Client brief

- [ ] Property Intel shows **Client brief** card when intake captured client/notes
- [ ] Client name, email, notes, intake source chip display correctly

### Site / Property Intel

- [ ] Map: layers, generate layers, citation → Map highlight (Property Intel drill-in)
- [ ] Property Intel: briefing sources, scroll, no layout trap

### Review

- [ ] Findings: **CODE·…** pills open popup (no navigation away from findings)
- [ ] Submissions / tasks / letters reachable under Review view

### Deliver — Packages

- [ ] Deliver → **Packages** segment (single hub; old publish-prep / client-materials routes consolidated)
- [ ] Create package per template: client-presentation, client-review, publisher-handoff, jurisdiction-manifest
- [ ] Publisher handoff: export ZIP downloads (CSV + plans + renderings + videos + manifest)
- [ ] Client review: generate share link
- [ ] Share URL `/share/{token}` loads for external reviewer
- [ ] Share page accepts comment (if enabled in build)

### Studio

- [ ] Rendering tab reachable under Studio view

### Regression spot-checks

- [ ] Existing engagement opens; snapshots/sheets still load
- [ ] Submit to jurisdiction (header) still opens expected flow
- [ ] Edit details in header updates engagement

---

## 6. Local dev vs production QA

| Mode | Good for | Not good for |
|------|----------|--------------|
| Vite `:20296` + dev-proxy → Cloud Run | IA, layout, read-only API paths | Create engagement, packages CRUD, DB-backed intake |
| Vite + **local api-server** (`DATABASE_URL` set, `:8080`) | Full stack before deploy | Parity with production secrets/env |
| **Production deploy** | Real QA sign-off | — |

Local api-server (Windows):

```powershell
cd P:\ldt-replit-ui   # or legacy-design-tools after merge
$env:DATABASE_URL = "postgresql://..."   # Neon dev branch
$env:PORT = "8080"
$env:AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://anthropic.test.invalid"
$env:AI_INTEGRATIONS_ANTHROPIC_API_KEY = "test-key-not-real"
$env:SNAPSHOT_SECRET = "dev-local"
pnpm --filter @workspace/api-server run dev:local
```

Second terminal: design-tools with `API_PROXY_TARGET` unset; Vite proxies `/api` → `:8080`.

---

## 7. Sign-off

**Branch QA complete (UI-only):** _______________  Date: _______

**Merged to main:** _______________  PR(s): _______

**Deployed to production:** _______________  Build/ref: _______

**Production QA complete:** _______________  Date: _______

**Blockers filed:** (link issues or `_research/` notes)

---

## Key paths (quick index)

| Area | Path |
|------|------|
| IA registry | `artifacts/design-tools/src/components/engagement-detail/engagementViews.ts` |
| Intake modal | `artifacts/design-tools/src/components/intake/ClientIntakeModal.tsx` |
| Client brief card | `artifacts/design-tools/src/components/engagement-detail/ClientBriefCard.tsx` |
| Packages UI | `artifacts/design-tools/src/components/engagement-detail/packages/` |
| Packages API | `artifacts/api-server/src/routes/packages.ts` |
| Create engagement | `artifacts/api-server/src/routes/engagements.ts` (`POST /engagements`) |
| DB schema | `lib/db/src/schema/engagementPackages.ts` |
| Share viewer page | `artifacts/design-tools/src/pages/PackageShareViewerPage.tsx` |
| Prior handoff | `_research/2026-05-24_cockpit-ia-agent-handoff.md` |
