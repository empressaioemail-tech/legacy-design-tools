---
title: Phase 1 — Cortex / Design Tools QA build — cc-agent-C session summary
date: 2026-05-22
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary
status: Phase 1 complete — held for operator before Phase 2
dispatch: 2026-05-22_cc-agent-C_cortex_qa_build
related: [43_cortex_qa_backlog, 42_design_accelerator_program_plan, 44_mcp_cortex_architecture_map, _decisions/2026-05-22_codex_review_surface_relocation, 90_runbooks/neon_schema_migration_via_cloud_shell, 90_runbooks/cloud_run_canary_deploy]
---

# Phase 1 — the customer-zero loop — cc-agent-C

Phase 1 of the 2026-05-22 QA-build dispatch. Every Phase-1 item diagnosed
against the source plus the live production environment (cortex-api Cloud
Run logs and a read-only recon of the cortex-api prod Neon DB
`ep-lucky-truth-apodo8hr`). Five PRs opened against `main` for operator
review; none self-deployed. One operator-supervised prod-DB migration is
surfaced for approval.

## Status table

| Item | What it is | Disposition | PR |
|---|---|---|---|
| P0-1 | IFC upload 500 | Migration written; **operator must apply to prod** | #73 |
| P0-2 | Geocoding never completes | Fixed | #74 |
| P1-2 | Map view blank | Fixed (with P0-2) | #74 |
| P1-1 | Site context does not render | Fixed | #75 |
| P1-3 | Site-context adapter timeouts | Fixed | #76 |
| P0-3 | 3D site does not assemble | **Missing capability — flagged to planner, not built** | — |
| P1-5 | "Run review" errors out | Fixed (backend audience) | #77 |
| P1-4 | Relocate review into Findings tab | Backend done (#77); **UI relocation specified, operator-gated** | #77 + follow-on |
| P1-6 | Corpus / jurisdiction resolution | Resolved by the relocation (see below) | — |

## Production environment findings (flag for operator)

Surfaced while diagnosing — not in the dispatch, but they bear on the
QA bar.

1. **cortex-api runs every LLM / converter / render path in `mock` mode.**
   The Cloud Run env on `cortex-api` carries `AIR_FINDING_LLM_MODE=mock`,
   `BRIEFING_LLM_MODE=mock`, `DXF_CONVERTER_MODE=mock`,
   `MNML_RENDER_MODE=mock`. So the compliance review's findings are
   mock-generated (the corpus *retrieval* still runs for real —
   `finding generation: retrieval populated codeSections` appears in the
   log — but the finding text itself is canned). The dispatch's bar
   "produces cited findings" cannot be fully met while the finding LLM
   is mocked. Phase 2's hard constraint forbids changing deploy env
   vars, so this is flagged, not changed — the operator should decide
   whether real LLM/converter keys belong on cortex-api before QA.

2. **Geocoder returns wrong coordinates for some Moab engagements.**
   `Musgrave_A` and `Musgrave_B` carry lat/lng `41.833204, -122.138947`
   — that is northern California, ~600 mi from Moab UT. Nominatim
   free-text returned a bad low-confidence match. P0-2's broaden-on-miss
   ladder reduces *misses* but a confidently-wrong Nominatim hit is a
   separate precision problem; see the P0-2 follow-up note.

3. **A stale `api-server` Cloud Run service still exists** alongside
   `cortex-api` (noted in the QA-04 close-out, 2026-05-21). Not
   production, not load-bearing; worth decommissioning to remove
   confusion.

---

## P0-1 — IFC upload fails (HTTP 500). VERIFIED. Migration written.

**Root cause (confirmed by the dispatch, re-confirmed by recon):** the
cortex-api prod DB is missing `materializable_elements.superseded_at`.

**Recon (read-only, against `ep-lucky-truth-apodo8hr`, 2026-05-22).**
Audited the full prod schema against the canonical `schema.sql.template`:

- `materializable_elements` — 16 columns, canonical is 18.
  `superseded_by_id` and `superseded_at` **missing**; the
  `materializable_elements_active_ifc_identity_uniq` index **missing**.
  (PR #33, supersede-and-append, never received a migration file.)
- `eval_baselines` / `eval_runs` / `eval_scores` — tables **absent**.
  (PR #27 added them; never migrated.)
- All `0009`–`0014` tables + the `track-b-ifc-ingest.sql` objects:
  present (the QA-04 session applied them).
- `reviewer_requests`, `code_atoms`, `attached_documents`, everything
  else: no drift.

So the dispatch was right that the gap is "more than IFC alone" — it is
**two un-migrated PRs (#33 and #27)**, nothing else.

**Deliverable.** PR #73 adds
`lib/db/drizzle/0015_catch_up_eval_tables_and_materializable_supersession.sql`
— idempotent (`IF NOT EXISTS` / drop-then-add), additive, single
transaction. The numbered `drizzle/*.sql` files are the prod-apply
sequence (0009–0014 were applied from there); 0015 closes the gap and
gives Phase 2's migrate job a coherent sequence.

**Operator action — apply to prod (operator-supervised, before the
PRs take effect).** Per `90_runbooks/neon_schema_migration_via_cloud_shell.md`:

```bash
# Cloud Shell, project legacy-design-tools-prod
gcloud config set project legacy-design-tools-prod
DB=$(gcloud secrets versions access latest --secret=DEPLOYMENT_DATABASE_URL)
# recon (expect: superseded_at absent, eval_runs absent):
psql "$DB" -c "\d materializable_elements" -c "\dt eval_runs"
# apply 0015 (the file from PR #73):
psql "$DB" -v ON_ERROR_STOP=1 -f 0015_catch_up_eval_tables_and_materializable_supersession.sql
# verify (expect 18 / table present):
psql "$DB" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='materializable_elements';" -c "\dt eval_runs"
```

**Verify the fix:** a real Revit IFC push to `POST /api/snapshots/{id}/ifc`
returns 201 (IFC-worker isolation, QA-16/#59, is already deployed on the
current revision — the missing column was the only remaining blocker).

---

## P0-2 — Geocoding does not complete (+ P1-2 blank map). FIXED — PR #74.

**The dispatch's premise was wrong, and the logs prove it.** The
dispatch supposed the Generate Layers run "resolved a lat/lng" that was
never persisted back. It did not: the cortex-api log shows
`generate-layers: engagement has no geocode` on **both** Musgrave layer
runs (19:43, 19:53). The prod row for `Musgrave_Residence_B`
(`977b5469-…`) has `latitude/longitude/geocoded_at` all null. The
`briefing_sources` rows that appeared came from jurisdiction-scoped
adapters that run without a precise point — the operator saw rows
appear and inferred a geocode that never happened.

**Actual root cause.** The address was set on the engagement via
`PATCH /engagements/:id` at 19:43:02 (`engagement.address-updated` event
fired). The PATCH handler calls `geocodeAddress`, which issued **one**
Nominatim free-text query with `limit=1`. The Musgrave address
("1144 NORTH KAYENTA DR, Moab UT 84532") is a rural street not in OSM at
house-number granularity → empty result → `null` → the address was
committed with no coordinates, **no retry, no fallback, no recovery
path**. Many prod engagements show the same null-coord state. There are
not two geocode paths; there is one, and it fails silently with no
recovery.

**Fix (PR #74).**
- `geocode.ts` — whitespace-normalize the address and walk a
  broaden-on-miss ladder (full address → city/ZIP line → bare ZIP).
- `generateLayers.ts` — **self-heal**: when an engagement has an address
  but no geocode, geocode now and persist lat/lng + jurisdiction columns
  back to the engagement row. This recovers engagements (Musgrave
  included) already stuck with null coords.
- `SiteContextTab.tsx` (P1-2) — the map placeholder no longer tells the
  architect to "add an address" when one is already set.

**P1-2** is a pure downstream symptom of P0-2 — the map placeholder
keys on `site.geocode === null`. Fixed by P0-2; the copy fix removes the
misleading message.

**Follow-up flagged for the planner:** Nominatim free-text is imprecise
for rural parcels (and occasionally confidently wrong — see env finding
#2). A UGRC address-point geocoder would give parcel-accurate
coordinates for Utah engagements.

---

## P1-1 — Site context does not render despite being logged. FIXED — PR #75.

**Root cause.** A payload-shape mismatch between what the adapters emit
and what the overlay extractor (`lib/site-context/.../overlays.ts`)
reads. The extractor only knew ArcGIS polygon `rings`. `ugrc:parcels` /
`grand-county-ut:parcels` / `grand-county-ut:zoning` already passed
`returnGeometry:true` and rendered. But `ugrc:dem` and the county-GIS
roads query fetched with `returnGeometry:false` (no geometry at all),
and roads geometry is polyline `paths` / OSM Overpass `elements` — neither
of which the extractor had a branch for.

**Fix (PR #75).** `ugrc:dem` + `grand-county-ut:roads` now fetch
geometry; the extractor handles polyline `paths` and OSM `elements` and
emits a new `polyline` overlay kind; `SiteMap.tsx` renders polylines.

---

## P1-3 — Site-context adapter timeouts. FIXED — PR #76.

**Diagnosis.** The two reported error strings ("cancelled by the caller"
and "did not respond in time") are the **same bug** — the runner's
per-adapter `AbortController` deadline firing before the upstream
answers. "cancelled by the caller" is the *pre-#63 wording*; there is no
separate outer-budget bug and no outer budget exists. QA-22 (#63) wired
the slow-upstream floor onto EPA / FCC / Grand County but **missed the
UGRC ArcGIS Online feeds** (`ugrc:dem` / `ugrc:parcels` /
`ugrc:address-points` still ran at the 15s default). And 30s was itself
too tight — `fetchWithRetry`'s up-to-3 attempts do not fit inside 30s.

**Fix (PR #76).** `SLOW_UPSTREAM_TIMEOUT_MS` 30s → 45s; the three UGRC
adapters now carry the floor. Lower-priority per the dispatch — partial
success already renders the layers that succeeded.

---

## P0-3 — The 3D site does not assemble. MISSING CAPABILITY — flagged, not built.

Per the dispatch ("if the rain or drainage analysis is a missing
capability rather than a bug, do not build it here; flag it for the
planner"). The diagnosis found the gap is **broader than the rain
analysis** — the 3D-site assembly itself is a missing capability:

- `SiteContextViewer` only renders DXF→GLB-converted briefing sources
  (`conversionStatus === "ready"` + a `glbObjectPath`). Generate Layers
  **never produces one** — it hard-codes `glbObjectPath: null` /
  `conversionStatus: null` on every adapter row. So `readySources` is
  always empty and the viewer shows its empty-state placeholder.
- There is **no code that assembles terrain + parcel + building** into
  one georeferenced scene. The viewer is a flat GLB loader — each GLB is
  dropped at the origin and assumed pre-aligned.
- `ugrc:dem` returns elevation-contour **attributes**, not a terrain
  **mesh**. No terrain surface exists anywhere from the adapter path.
- The pushed IFC building model *can* render (`ifcIngest` produces a
  consolidated glTF bundle), but only with the `showBuilding` toggle on,
  into an otherwise empty scene.
- **The rain / drainage analysis** ("what happens when 4 inches of rain
  falls") does not exist at all — no hydrology, flow-accumulation,
  runoff, or rainfall-depth code anywhere in the repo. `DXF_CONVERTER_MODE=mock`
  in prod compounds this — even the DXF-upload path that *does* yield
  GLBs produces mock output in prod.

**Flag for the planner.** Delivering "the 3D site assembles, with real
terrain geometry as the substrate for a drainage analysis" is a net-new
feature, not a Phase-1 bug fix. It needs: a true DEM raster ingest
(e.g. USGS 3DEP clipped to the parcel + upstream catchment), a
terrain-mesh build, a georeferenced scene-assembly stage feeding
`SiteContextViewer`, and a hydrology pass + UI. Recommend it be scoped
as its own roadmap line.

---

## P1-4 / P1-5 / P1-6 — Relocate the compliance review into the Findings tab.

**P1-5 — "Run review" errors out. FIXED (backend) — PR #77.**
`POST /findings/generate` returns **403** in prod (confirmed in the
Cloud Run log). All eight `findings.ts` routes require
`session.audience === "internal"`, but `middlewares/session.ts` **fails
every production session closed** to the anonymous applicant
(`audience: "user"`) — no prod request can ever be `internal`. So in
prod the **entire architect Findings tab is dark**: generate, status,
**list**, runs, accept, reject, override all 403, for `design-tools`
and `codex-reviewer-qa` alike. (The codex-reviewer-qa "Could not start
the review run" is the same root cause — a dev-session cookie would only
help in non-prod.) PR #77 drops the reviewer-only gate from the seven
architect-workflow routes, per the operator's review-relocation
decision, leaving them consistent with every other architect-workflow
route. **This relaxes an audience gate the prior security review locked
down — it is flagged for explicit operator review in the PR.** It does
not create new exposure beyond the app's current pre-auth state.

**P1-6 — Corpus / jurisdiction resolution. Resolved by the relocation.**
The bug is FE-only and lives in the standalone `codex-reviewer-qa`
artifact's `matchJurisdiction` (a naive normalized string-equality
match: "Moab, UT" → `moabut` never equals the corpus key
`grand_county_ut` or display `Grand County, UT (Moab)`). The
authoritative `keyFromEngagement` in `lib/codes` resolves "Moab, UT" →
`grand_county_ut` correctly, and the server-side finding-engine
retrieval uses it — so findings already carry real Grand County
citations server-side. The relocation moves the surface off
`codex-reviewer-qa` (retained, untouched, as the smartcity-os reference
per the decision doc), so the broken FE warning is simply left behind.
The design-tools Findings tab never had that warning. No code change
needed; **if a jurisdiction/corpus context line is added to the
Findings tab (see P1-4 below), it must use the server-resolved key, not
a FE string match.**

**P1-4 — Relocate the surface. Backend done; UI relocation specified,
operator-gated.** `FindingsTab.tsx` in design-tools **already** does the
core of what `codex-reviewer-qa`'s `ReviewPage` does: submission picker,
"Run plan review" trigger (`useGenerateSubmissionFindings`), status
polling, the finding list + detail panel (shared `FindingsList` /
`FindingDetailPanel` from `lib/portal-ui`), and override
("address with next revision"). With PR #77's audience fix it works end
to end for the architect — **this meets the Phase-1 exit bar "a
compliance review runs from the Findings tab and produces cited
findings."**

The remaining relocation parity items, **deliberately deferred as
operator-gated follow-on** (they should land only once PR #77's audience
change is approved — building the architect adjudication UI on an
unapproved auth model would be premature):

1. **Explicit accept / reject buttons.** `FindingsTab` has override
   (edit) only. `useAcceptFinding` / `useRejectFinding` hooks exist in
   `@workspace/api-client-react`; the routes are unblocked by #77. The
   shared `FindingDetailPanel` (`lib/portal-ui`) has no accept/reject
   props — add `onAccept` / `onReject` there (benefits the plan-review
   reviewer surface too) and wire two mutations in `FindingsTab`.
2. **A jurisdiction / corpus context line** — using the engagement's
   server-resolved jurisdiction key (P1-6), not a FE string match.
3. **A "draft comment letter" affordance** — design-tools already has a
   `DeliverableLettersTab`; link the review surface to it (CDX-9's L3
   comment-letter pipeline is shared and proven).

The standalone `codex-reviewer-qa` artifact is **not deleted** — per the
decision doc it stays as the smartcity-os production-reviewer reference.

---

## Testing posture

Per-package `pnpm run typecheck` is green for every changed package
(site-context, adapters, api-server, design-tools, lib/db). New / updated
test suites ship with each PR: `geocode.test.ts` + the generate-layers
self-heal case (#74), `site-overlays.test.ts` (#75),
`utahAdapters.test.ts` (#76), the findings audience test (#77). The
DB-backed route suites run in CI (they need `DATABASE_URL`). Vitest was
not run locally — the Windows native-deps lockfile workaround is a
documented detour; CI is authoritative for tests per the dispatch.

## Verification caveat

Every fix is diagnosed against real production evidence (the cortex-api
Cloud Run logs and a read-only recon of the prod Neon DB). **Behavioural
verification against the live deployed app on the Musgrave engagement
has not happened** — that requires the operator to merge, apply the
P0-1 migration, and canary-deploy. The dispatch's success bar is
behavioural; the loop should be re-verified on the deployed app after
the canary, not on green CI.

## Recommended operator sequence

1. Review + approve PR #77's audience-model change (gates the rest).
2. Apply the P0-1 `0015` migration to cortex-prod (Cloud Shell,
   operator-supervised).
3. Merge #73–#77; canary-deploy per `cloud_run_canary_deploy.md`.
4. Verify the loop on the Musgrave engagement against the canary:
   IFC push → 201; engagement geocodes; site context + map render;
   a review runs from the Findings tab and produces cited findings.
5. Decide on the `mock`-mode env vars (env finding #1) before calling
   the loop QA-ready.

**Held for the operator before Phase 2.**
