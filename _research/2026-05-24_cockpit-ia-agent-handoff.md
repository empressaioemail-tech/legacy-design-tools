# Agent handoff — Cockpit IA consolidation (`ldt-replit-ui`)

**Date:** 2026-05-24  
**Branch:** `replit/ui-cockpit-ia-consolidation`  
**Latest commit:** `246fbba` — `feat(design-tools): cockpit IA follow-through — site split, client deck, view cube`  
**Worktree:** `P:\ldt-replit-ui` (NOT `P:\legacy-design-tools`)

Orchestrator: push when ready; agents do not merge PRs. No `gh` CLI — PR via URL after `git push -u origin replit/ui-cockpit-ia-consolidation`.

---

## What this sprint did (shipped in commit)

### Engagement IA (`engagementViews.ts`)

| Old | New |
|-----|-----|
| Top view `publish` | **`studio`** |
| Studio segment `publish-prep` | Still **Publish** (mission control) |
| Studio segment `renders` | **Rendering** |
| Studio segment `presentations` | **Presentations** / client deck |
| Model segment `sheets` | Moved to **Deliver → Sheets** |
| Site segment `site-context` | **`property-intel`** (Property Intel) |
| Site segment `site` | **Map** (renamed label; tab id still `site`) |

Legacy URLs: `?tab=site-context` → Property Intel; `?view=publish` → studio.

### Site — Map vs Property Intel

- **`SiteTab.tsx`** — Map hero (resize, inspector, layer palette, 3D toggle). **Layers & adapters** panel embeds `SiteContextTab` with `panelFocus="layers"`. Toolbar: Add layer, Upload QGIS, Generate layers → scroll to `#site-layers-panel`.
- **`PropertyIntelTab.tsx`** — Scrollable scope cards, rainfall callout, roadmap overlays, briefing-only `SiteContextTab` (`panelFocus="briefing"`, `onNavigateToMap`).
- **`SiteContextTab.tsx`** — `panelFocus`: `"layers" | "briefing" | "full"`. Split empty states; briefing head on intel only.
- **CSS:** `.property-intel-scroll` flex + `overflow-y: auto`; `.briefing-sources-tier-grid` for layer cards.

### Presentations — client deck (UI shell only)

- **`presentationTemplate.ts`** — Page types (cover, moodboard, floor plan, FF&E, etc.) with `templatePages` counts (~30 when all selected).
- **`PresentationsTab.tsx`** — Reframed from plan-review sections to **client presentation**; PDF export mock; Canva/share placeholders.
- **`presentationFlow.ts`** — Steps: Choose pages → Preview → Export → Versions.

**Not wired:** real PDF, Canva API, atom assembly into layouts.

### BIM / View cube (`lib/portal-ui`)

- **`BimViewCube.tsx`**, **`viewCubeModel.ts`** — Revit-style 26-region cube.
- **`BimModelViewport.tsx`** — Canvas host vs overlay split (fixes OrbitControls detach); drag-to-rotate on model.
- Tests: `BimModelViewport.test.tsx` (63 pass).

### Other shells (same commit, less conversation focus)

- Dashboard, Inbox action queue, Settings subnav, Deliver workbench hub, Render workbench, Snapshots sheet rail, Studio create/refine panels.
- Large `index.css` + `docs/ui-ia-cockpit-consolidation-plan.md` updates.

---

## Verify before PR

```powershell
cd P:\ldt-replit-ui
pnpm install   # if workspace links stale after rebase
pnpm run typecheck
cd artifacts\design-tools
pnpm exec vitest run src/pages/__tests__/EngagementDetail.test.tsx src/pages/__tests__/SiteContextTab.test.tsx src/pages/__tests__/SiteContextBriefingProgress.test.tsx
cd ..\..\lib\portal-ui
pnpm exec vitest run src/components/__tests__/BimModelViewport.test.tsx src/components/__tests__/BriefingSourceRow.test.tsx
```

**SiteContext tests** must deep-link to Map for layers UI:

- `/?view=site&segment=site` — Generate Layers, source rows
- `/?tab=property-intel` — briefing progress tests use Map URL for generate button (see `SiteContextBriefingProgress.test.tsx`)

---

## Suggested next tasks (priority)

1. **Presentations backend** — Assemble page types from engagement atoms; real PDF export; optional Canva handoff spec.
2. **Rename segment label** — User may want rail label **"Client presentation"** vs **"Presentations"** (`engagementViews.ts` segment label).
3. **Property Intel polish** — Confirm scroll on all viewports; post-navigate highlight source on Map after citation jump.
4. **Presentations segment title** — Align `TabHeader` / inbox seed copy with product naming.
5. **CI** — Run full `pnpm run typecheck` at repo root; fix any per-artifact `tsc` failures on branch.
6. **Rebase** — If `main` moved, rebase worktree; run `pnpm install` if new workspace packages.

---

## Key files (quick index)

| Area | Path |
|------|------|
| IA registry | `artifacts/design-tools/src/components/engagement-detail/engagementViews.ts` |
| Engagement shell | `artifacts/design-tools/src/pages/EngagementDetail.tsx` |
| Map | `.../SiteTab.tsx` |
| Property Intel | `.../PropertyIntelTab.tsx` |
| Layers + briefing logic | `.../SiteContextTab.tsx` |
| Client deck | `.../PresentationsTab.tsx`, `presentationTemplate.ts`, `presentationFlow.ts` |
| View cube | `lib/portal-ui/src/components/BimViewCube.tsx`, `viewCubeModel.ts`, `BimModelViewport.tsx` |
| Layer card grid CSS | `lib/portal-ui/src/styles/smartcity-components.css` (`.briefing-sources-tier-grid`) |
| Plan doc | `docs/ui-ia-cockpit-consolidation-plan.md` |

---

## Out of scope / other repo

- **`P:\legacy-design-tools`** has unrelated openapi/codegen drift — do not mix with this UI branch unless explicitly merging spec work.
- Tenant / SmartCity OS rules do not apply here.

---

## Agent workflow reminder (from AGENTS.md)

Recon → orchestrator approves → execute → report. Never guess on `str_replace` anchors. Do not commit unless asked. Do not merge PRs. Windows: CRLF on `openapi.yaml` if touching spec in main repo.
