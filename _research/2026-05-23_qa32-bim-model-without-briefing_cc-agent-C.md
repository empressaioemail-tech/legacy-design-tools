---
title: QA-32 — surface as-built IFC elements on the IFC-without-briefing path
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary
status: PR open, held for operator merge + redeploy
related: [43_cortex_qa_backlog, 00_current_state, 90_runbooks/cloud_run_canary_deploy]
---

# QA-32 — IFC-without-briefing BIM viewer surface — cc-agent-C

## PR

**[#85](https://github.com/empressaioemail-tech/legacy-design-tools/pull/85)** — `fix/qa-32-bim-model-without-briefing`, commit `a69ae48`, off `origin/main` (`d95313e`). Built in an isolated `git worktree` at `p:/tmp/qa32-worktree` per the workspace-hygiene memory.

## Symptom + verified DB state

After PR #83 closed the architect-audience gate, the `cortex-api-00017-jnn` Musgrave_Residence_B verify confirmed (read-only recon, 2026-05-23 against the prod Neon):

- **101 active `materializable_elements`** for engagement `977b5469-...` — 100 `as-built-ifc` + 1 `as-built-ifc-bundle`, all `superseded_at IS NULL`, all bound to `source_snapshot_id = 31a061f1-...`.
- **`bim_models` row exists** (`1fa4b264-...`, created same second as the IFC ingest) with `active_briefing_id = NULL` and `materialized_at = NULL`.
- **`snapshot_ifc_files`**: the latest row (`e6696eaf-...`) has `parsed_at = 2026-05-23T02:17:02.708Z` and `has_gltf = true`; an earlier `1275ded9-...` row has `parsed_at = NULL` (an upload that never parsed cleanly).

Yet the FE shows "0 ELEMENTS / No BIM elements yet".

## Root cause

Two coupled gaps, both on the IFC-without-briefing path:

1. **`lib/ifcIngest.ts` UPSERT was `ON CONFLICT DO NOTHING`** with the rationale "the IFC ingest is as-built provenance and must not clobber the to-be-built columns." The INSERT path also didn't set `materialized_at`. Result: `bim_models.materialized_at = NULL` whenever an engagement was pushed via IFC without a prior briefing-driven Push-to-Revit.

2. **`routes/bimModels.ts` as-built load was over-scoped**. The helper joined `snapshot_ifc_files` and required `parsed_at IS NOT NULL`, then filtered elements by `source_snapshot_id = (latest parsed snapshot)`. The snapshot-id scope is redundant — element-level `superseded_at IS NULL` already keeps prior-ingest rows hidden (per PR #33's `materializable_elements_active_ifc_identity_uniq` partial index). And the `parsed_at` gate dropped as-built elements during the brief race window between the elements transaction committing (step 5 of `ingestSnapshotIfc`) and `parsed_at` being stamped (step 6) — the most plausible mechanism for "FE polled and got 0 elements" against a known-101-element prod state.

## Fix

**Change 1 — `lib/ifcIngest.ts`**: the bim_models UPSERT now sets `materialized_at = now()` (and `updated_at`) on both INSERT and ON CONFLICT. `activeBriefingId`, `briefingVersion`, `revitDocumentPath` stay untouched — IFC ingest continues to have no opinion about them. `materialized_at` now means "the most recent successful materialization (briefing OR IFC)" — the briefing-push handler in `routes/bimModels.ts` already sets it the same way.

**Change 2 — `routes/bimModels.ts`**: split `loadAsBuiltIfcElementsForEngagement` into two helpers:
- **`loadActiveAsBuiltIfcElementsForEngagement(engagementId)`** — engagement-scoped only: `WHERE engagement_id = $1 AND superseded_at IS NULL AND source_kind IN ('as-built-ifc','as-built-ifc-bundle')`, bundle-first ordering. Used by both `toBimModelWire` and the synthesize path.
- **`loadLatestParsedIfcFileForEngagement(engagementId)`** — for the synthesize path's `materializedAt` and synthetic wire id.

`toBimModelWire` now unions the engagement's active as-built rows independently of `bm.activeBriefingId`. The briefing-derived branch (`bm.activeBriefingId ? loadElementsForBriefing(...) : []`) is **unchanged** — no regression for the briefing-driven path.

## Tests

`ifc-ingest-bim-model-atom.test.ts`:
- The "fresh insert" assertion flips from `materializedAt = null` to `materializedAt instanceof Date`.
- The "preserves activeBriefingId / materializedAt..." test is rewritten as "refreshes materializedAt but preserves activeBriefingId / briefingVersion / revitDocumentPath" — asserting the new semantic AND protecting the to-be-built columns from being clobbered by re-ingest.

`bim-models.test.ts`:
- New QA-32 test in the `GET /api/engagements/:id/bim-model` describe block. Seeds an IFC-without-briefing engagement (no `parcel_briefings` row, `bim_models` row with `active_briefing_id = NULL`, 3 active as-built `materializable_elements` rows: 1 bundle + 2 entities). Asserts the GET returns `elements.length === 3` in bundle-first order.

Per-package `pnpm run typecheck` green (libs + api-server).

## Out of scope (per the dispatch)

- The Phase 3 features (QA-27 link-drop, QA-28 letter, QA-29 presentations) stay deferred until QA-32 closes and the customer-zero loop verifies end-to-end on the deployed app.
- The notifications 401s on `/api/me/notifications` are a separate session-auth issue, lower priority, separate PR if pursued.
- `_schema_migrations` bootstrap (the Phase 2 P2-2 run-migrations workflow) — still operator's call, not blocking.
- `mock`-mode env-var decision — operator-side.

## Post-merge

Held for operator merge. Redeploy via the 2026-05-22 cortex-api addendum in `90_runbooks/cloud_run_canary_deploy.md`: the operator's direct `gcloud run deploy ... apps/cortex-api:latest` + `update-traffic --to-latest --clear-tags` form. After redeploy, verify `GET /api/engagements/977b5469-.../bim-model` returns `elements.length === 101`.
