---
session_id: 2026-05-23_regrid_scope_b_session_close
author: cc-agent-C2
date: 2026-05-23
dispatch: cortex-prop-intel-regrid-scope-b
doctrine: P:\doc_repo\_decisions\2026-05-23_partnership_first_scoping.md
session_a_summary: P:\doc_repo\_sessions\2026-05-23_regrid_eval_scope_a_cc-agent-C2.md
status: pr-open-awaiting-merge
pr: https://github.com/empressaioemail-tech/legacy-design-tools/pull/104
related_canonical: [40d_cortex_site_context_sprint, 43_cortex_qa_backlog]
---

# Cortex prop-intel SCOPE B session close — Regrid baseline shipped

PR #104 (cortex/regrid-baseline) is open and awaiting operator merge.
238/238 adapter tests pass + 341/341 design-tools tests pass + full
workspace typecheck clean. The build also clears the dispatch's
"227+ existing adapter tests still pass, +6 new tests" gate — the
adapter suite went from 227 → 238 (10 net new + 1 test renamed via
the eligibility splits).

## What shipped

The dispatch's 8-point implementation plan executed end-to-end:

| # | Sub-task | Lands as |
|---|---|---|
| 1 | Adapter placement | `lib/adapters/src/national/regrid.ts` (new `national/` directory) |
| 2 | Two adapters with shared HTTP cache | `regrid:parcels` + `regrid:zoning`, sharing one `/parcels/point` call via a concurrent-safe in-memory dedup Map (15-min TTL) |
| 3 | Payload shape extension | `lib/site-context/src/client/overlays.ts` recognizes GeoJSON Polygon + MultiPolygon at `payload.parcel.geometry` / `payload.zoning.geometry` (ArcGIS-rings branch untouched + regression-tested) |
| 4 | Provenance mapping | `snapshot_date ← ll_last_refresh`, `provider ← "Regrid (via <county>)"`, `layer_kind ← "regrid-parcel"/"regrid-zoning"`, `source_kind ← "national-aggregator"` (new value; no schema migration — `briefing_sources.source_kind` is `text NOT NULL`) |
| 5 | Cache reuse | Federal-tier housing puts the adapters under the runner's default federal cache predicate; 24h Postgres `adapter_response_cache` + 15-min in-memory dedup both apply |
| 6 | Runner wiring | Regrid fires for ALL geocoded engagements; `grand-county-ut.ts`'s `appliesTo` now requires `ctx.jurisdiction.partnerCity === true`. Default engagements skip the per-county adapters as `no-coverage` |
| 7 | Tests (min 6) | 10 Regrid adapter tests + 5 overlay GeoJSON tests + 4 eligibility tests updated |
| 8 | Env vars | `REGRID_API_KEY` read via `process.env`; operator already provisioned the Cloud Run secret |

## Implementation decisions

The dispatch left a few choices "to my call." Documenting them here so
the next agent (or cc-agent-C2 in a future session) can flip them
cheaply if the operator surfaces a counter-finding.

**Tier classification — `tier: "federal"`.** Reused the federal tier
rather than introducing a new `"national"` enum value to keep the diff
local. Cross-cutting changes would have been needed in
`lib/site-context/src/client/SiteMap.tsx`'s `TIER_STYLES` +
`TIER_LABELS`, `lib/site-context/src/client/overlays.ts`'s
`SiteMapOverlayTier` union, and the per-tier color mapping. The
operator-visible source attribution lives at `source_kind =
"national-aggregator"`, which IS new and IS surfaced on the wire —
the FE can render a distinct pill if UX needs without a backend
change. Real "national" tier UI is a follow-on.

**One PR or two — one PR.** Both adapters share scope (one upstream
endpoint, one dedup map, one set of provenance mappings, one set of
runner-wiring concerns, one structured-logging helper). Splitting
would have created an artificial seam without making the operator's
merge story simpler.

**`partnerCity` gate scope — `grand-county-ut` only.** The dispatch
named grand-county-ut specifically. Lemhi County (ID) and Bastrop
(TX) per-county adapters are NOT gated in this PR. Bastrop is the
canonical Hauska substrate partner so the dispatch's intent already
applies (Bastrop engagements would carry `partnerCity: true`);
Lemhi is a coverage gap to decide later. **Documented as a follow-on
in the PR description.**

**No migration.** Confirmed `briefing_sources.source_kind` is
`text NOT NULL` with no CHECK constraint — `"national-aggregator"`
adds without a 0016 migration. This was the dispatch's stated
preference and it held up against the codebase.

## Tests

| Suite | Result |
|---|---|
| `pnpm --filter @workspace/adapters run test` | **238/238** (10 new Regrid + 4 updated eligibility + 224 unchanged) |
| `pnpm --filter @workspace/design-tools run test` | **341/341** (5 new overlay-GeoJSON + 336 unchanged) |
| `pnpm run typecheck` (workspace-wide) | clean across all 7 artifacts + scripts |

10 Regrid adapter test cases (dispatch min was 6):
1. Happy path → both adapters one upstream call
2. Zoning-only no-coverage
3. **Trial-token out-of-coverage** → both surface as `no-coverage` (per the dispatch's "Build the adapter to handle the error envelope … surface as no-coverage, not as a hard error")
4. HTTP 5xx → `upstream-error` with body excerpt
5. Malformed JSON → `parse-error`
6. **Cache hit** → second run skips upstream entirely
7. **Partner-city enrichment** → `grand-county-ut:*` adapters fire alongside Regrid
8. **Non-partner skip** → only Regrid fires; county-GIS endpoints never touched
9. Registry shape — both adapters present in `ALL_ADAPTERS` under FEDERAL
10. Missing `REGRID_API_KEY` → diagnostic `upstream-error`, no upstream call

5 overlay GeoJSON test cases: GeoJSON Polygon · MultiPolygon (flattened
to N polygons) · zoning Feature · ArcGIS-rings regression guard ·
mixed valid/invalid coordinates with partial-skip.

## Trial-token coverage handling

The most material correctness concern from the dispatch:

> "Build the adapter to handle the error envelope that comes back when
> the trial token hits an out-of-coverage lat/lng — surface it as
> `no-coverage` (not as a hard error), so the failure pill reads cleanly."

The `isTrialOutOfCoverage` heuristic in `regrid.ts` checks for:
1. HTTP 200 response
2. Empty `parcels.features` array
3. An `error` envelope (string OR object) containing one of
   "trial", "coverage", "restricted", or "unauthorized"

When all three match, the adapter throws `AdapterRunError("no-coverage", …)`
which the runner translates into a `status: "no-coverage"` outcome on
the wire — UI surfaces a neutral pill, not a failure badge. Test case
#3 pins this behaviour. The heuristic is permissive (multiple keyword
hits) on purpose — if Regrid changes the exact error wording, the
adapter still catches it.

If the operator's paid plan ships and the heuristic stays in place,
it remains a defensive guard for unusual mid-flight downgrades (e.g.
a billing-paused interval). Cost is one boolean per upstream
response.

## Structured logging

Mirrors PR #96's `fccLogEvent` pattern. `regridLogEvent(level, msg,
adapter_key, fields)` emits three events per upstream call:

- `regrid request start` (info) — `url` (token-redacted), `lat`, `lng`, `timeout_ms`
- `regrid request ok` (info) — `duration_ms`, `response_size_bytes`, `parcel_count`, `zoning_count`
- `regrid request failed` (warn) — `error_class` (`network` / `status` / `parse` / `out-of-coverage`), `duration_ms`, plus the appropriate excerpt field (`throw_excerpt`, `body_excerpt`, `parse_error`, `reason`)

Each adapter stamps its own `adapter_key` so a
`jsonPayload.adapter_key="regrid:parcels"` filter pulls one adapter's
trace cleanly even though both share the same `getOrFetchRegridPoint`
helper. URL redaction strips the `token` query param — no API-key
leakage into Cloud Run logs.

## Operational expectations after merge

When the operator deploys the resulting Cloud Run revision:

1. **Generate Layers on any geocoded engagement** now fires Regrid as
   the first national-tier baseline. Two new pills appear under the
   federal-tier group: `regrid-parcel` + `regrid-zoning`.
2. **Trial-restricted lat/lng** (UT, ID, anywhere outside the trial's
   7 counties) → pills read "no coverage" — clean, not red.
3. **Paid-plan upgrade** (operator next step) → pills read
   "ok · Regrid (via Grand County)" with the parcel polygon + zoning
   shape rendered on the SiteMap.
4. **Moab engagements (Musgrave_Residence_B, Redd)** → Regrid fires
   as baseline; `grand-county-ut:*` adapters now skip (gated on
   `partnerCity: false` by default). If the operator wants Grand
   County back as enrichment, flip `partnerCity = true` in the
   engagement record OR widen the gate.
5. **Bastrop engagements** → Regrid fires as baseline; bastrop-tx:*
   adapters continue to fire (not gated on partnerCity in this PR —
   they only apply when `localKey === "bastrop-tx"`, which already
   implicitly correlates with partner status).

## What this enables for Phase 2D.x

Per the dispatch: "Phase 2D.x (resumes on YOUR clone after Regrid
SCOPE B ships)". On merge:

- **PR #101** (site-topography atom registration, currently open and
  shape-only) can resume to **PR3** of Phase 2D.1 — the DEM ingest
  worker that consumes the parcel boundary from
  `payload.parcel.geometry` produced by Regrid.
- The persistence-pivot question I raised on #101 (event-sourced via
  `atom_events` vs migration-0016-backed
  `materializable_elements`) stands; the deferred answer is still
  operator-pending.
- The parcel-boundary fallback path I designed for PR3 (briefing-source
  first, geocode-bbox fallback) **gets simpler** post-Regrid: every
  engagement now has a Regrid parcel boundary available, so the
  fallback only triggers on out-of-trial-coverage engagements.

## Follow-ons (NOT in this PR)

- **Lemhi `partnerCity` gate** — uniform application to all per-county
  adapters. Decide after operator surfaces a real case.
- **Real `"national"` tier UI** — distinct pill color in
  `SiteMap.tsx` if UX wants Regrid visually separated from federal
  agencies (USGS/FEMA/FCC/EPA). One-file change against `TIER_STYLES`
  + `TIER_LABELS` + the union type.
- **Paid-plan smoke test** — operator-side; cannot be done from this
  PR until the secret is upgraded to a paid key.
- **Federal layer reconciliation (SCOPE C)** — separate dispatch.
  Grand County GIS VPC + NAT goes from REQUIRED to OPTIONAL per the
  SCOPE B exit clause; FCC + EPA decisions stand independently per
  cc-agent-C's track.

## Cross-references

- [Partnership-first scoping decision (2026-05-23)](../../doc_repo/_decisions/2026-05-23_partnership_first_scoping.md)
- [cc-agent-C2 SCOPE A session summary (2026-05-23)](../../doc_repo/_sessions/2026-05-23_regrid_eval_scope_a_cc-agent-C2.md)
- [cc-agent-C SCOPE A session summary (2026-05-23)](../../doc_repo/_sessions/2026-05-23_regrid_eval_scope_a_cc-agent-C.md) — convergent confirmation
- [Regrid OpenAPI v2 (operator-captured)](../../doc_repo/_research/2026-05-23_regrid_openapi_v2.yaml)
- PR #104 — https://github.com/empressaioemail-tech/legacy-design-tools/pull/104
- PR #96 — `fccLogEvent` structured-logging precedent
- Earlier session: PR #101 (site-topography atom, Phase 2D.1.3) — open, awaiting merge before Phase 2D.x resumes

## Hand-off

- **Operator next step**: merge PR #104; deploy the resulting
  cortex-api Cloud Run revision; smoke against a paid-plan-covered
  lat/lng to verify the live integration; flip the operator's Regrid
  trial token to paid when ready.
- **cc-agent-C2 next step on merge**: resume Phase 2D.1 — PR3 (DEM
  ingest worker) consumes `payload.parcel.geometry` from the Regrid
  briefing-source rows. Open question on persistence path
  (event-sourced vs migration 0016) still pending operator decision
  on PR #101.
