---
title: Cortex prop-intel SCOPE A — Regrid vs ATTOM vendor evaluation
date: 2026-05-23
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary
status: SCOPE A only. Recommendation in §6 — operator picks before
  SCOPE B (adapter implementation) fires.
dispatch: 2026-05-23_cortex_regrid_evaluation
related: [43_cortex_qa_backlog, 46_smartcity_parcel_intelligence, 73_partnerships, 2026-05-23_partnership_first_scoping]
---

# Cortex prop-intel architecture — vendor evaluation (SCOPE A)

Per dispatch: evaluate Regrid + ATTOM (+ CoreLogic only if both
fail), recommend a baseline parcel + zoning source, report. **No
code change this session.** SCOPE B (adapter implementation) fires
after operator picks the winner.

## 1. Recommendation (TL;DR)

**Pick Regrid.** It is the only one of the two candidates that:

1. Has the right query shape — **point-in-polygon** (lat/lng →
   enclosing parcel), which is exactly what the existing per-county
   GIS adapters use today and what the briefing engine consumes.
2. Carries **parcel geometry + zoning code + zoning description**
   in Standard tier. ATTOM carries property characteristics but
   does NOT document zoning OR geometry as response fields.
3. Has **self-serve pricing** at `app.regrid.com/api/plans` — no
   sales gate. ATTOM is sales-gated (contact form + phone number)
   which doesn't fit Cortex's operational tempo around ICC API
   landing this week.
4. Has explicit **provenance fields** (`sourceurl`, `county`,
   `geoid` FIPS, `ll_last_refresh` county refresh date,
   `ll_updated_at` Regrid mod timestamp) matching the dispatch's
   provenance-tagging requirement exactly.

CoreLogic recon skipped per dispatch step A.3.

## 2. Cortex consumer-side contract (read from main)

What downstream code expects from `payload.parcel.*` and
`payload.zoning.*`:

**Overlay extraction** ([`lib/site-context/src/client/overlays.ts:189-219`](lib/site-context/src/client/overlays.ts#L189-L219)):
- `payload.parcel.geometry` → ArcGIS `{ rings: [[[x,y], …], …], spatialReference: { wkid: 4326 | 102100 | 3857 } }`
- `payload.zoning.geometry` → same ArcGIS shape

**Parcel + zoning summary card** ([`lib/portal-ui/src/components/ParcelZoningCard.tsx`](lib/portal-ui/src/components/ParcelZoningCard.tsx) and [`lib/adapters/src/state/summaries.ts:165-170`](lib/adapters/src/state/summaries.ts#L165-L170) + [`local/summaries.ts:141-146`](lib/adapters/src/local/summaries.ts#L141-L146)):
- `payload.kind === "parcel"`
- `payload.parcel.attributes` → `Record<string, unknown>` with one of `PARCEL_ID_KEYS` (`PARCEL_ID`, `PARCELID`, …) + one of `PARCEL_ACRES_KEYS` (`ACRES`, `Acres`, …)
- `payload.zoning.attributes` → with one of `ZONING_CODE_KEYS` + one of `ZONING_DESC_KEYS`
- `payload.features[].attributes` for floodplain → with one of `FLOOD_ZONE_KEYS`

**Key-alias arrays** are defined in [`lib/adapters/src/_payloadSummaryHelpers.ts`](lib/adapters/src/_payloadSummaryHelpers.ts) — the summary helpers do `pickFirstString(attrs, KEYS)` so a Regrid adapter can either:
- emit Regrid's native field names (`parcelnumb`, `gisacre`, `zoning`, `zoning_description`) into `attributes` and **extend the key-alias arrays** to include them, OR
- map Regrid fields to one of the existing pilot-county names (`PARCEL_ID`, `ACRES`, `ZONING`, `ZONING_DESC`).

The first option preserves Regrid's native schema for downstream debugging; the second is one line of work. SCOPE B will pick one when wiring.

## 3. Regrid — detail

**Coverage**: nationwide US per Regrid marketing; trial covers 7
specific counties (Marion IN, Dallas TX, Wilson TN, Durham NC,
Fillmore NE, Clark WI, Gurabo PR — note **no UT trial coverage**).
Coverage detail at [`app.regrid.com/store`](https://app.regrid.com/store) (gated). **Operator verification needed** for Grand County UT (Musgrave, Redd) and Bastrop County TX during SCOPE B trial setup — flagged as a known unknown below.

**Schema** ([`support.regrid.com/parcel-data/schema`](https://support.regrid.com/parcel-data/schema)):

| Field | Tier | Cortex use |
|---|---|---|
| `parcelnumb` | Standard | → `payload.parcel.attributes.PARCEL_ID` |
| `ll_uuid` | Standard | Stable cross-refresh parcel id (Regrid v4 UUID) |
| `owner` | Standard | Optional briefing-engine prompt context |
| `address` | Standard | Reviewer-facing parcel summary |
| `gisacre` / `deeded_acres` | Standard | → `payload.parcel.attributes.ACRES` |
| `zoning` | Standard | → `payload.zoning.attributes.ZONING` |
| `zoning_description` | Standard | → `payload.zoning.attributes.ZONING_DESC` |
| `zoning_type` / `zoning_subtype` | **Premium** | Standardized zoning categories (cross-county normalization) |
| `fema_flood_zone` | **Premium** | Overlay district — could reduce FEMA NFHL adapter load |
| `padus_public_access` | **Premium** | Conservation overlay |
| `lbcs_*` | **Premium** | Land-use codes (LBCS taxonomy) |
| `county`, `geoid`, `sourceurl`, `ll_last_refresh`, `ll_updated_at` | Standard | Provenance |

Geometry is delivered in the API response (not in the tabular
schema), typically GeoJSON Polygon. The adapter needs a small
GeoJSON → ArcGIS-rings shim to match the existing
`overlays.ts` consumer contract.

**API**: REST, OpenAPI at
[`developer.regrid.com/llms.txt`](https://developer.regrid.com/llms.txt). Sandbox at
[`support.regrid.com/api/section/interactive-api-sandbox`](https://support.regrid.com/api/section/interactive-api-sandbox).
**Auth**: API key (header). **Exact point-in-polygon endpoint URL
not captured** in the marketing/sandbox pages I reached; OpenAPI
spec at `developer.regrid.com/llms.txt` should resolve this during
SCOPE B. The dispatch's expected pattern is something like
`GET /api/v2/parcels?lat=X&lng=Y&format=geojson`.

**Pricing**: self-serve plans listed at
[`app.regrid.com/api/plans`](https://app.regrid.com/api/plans)
(content gated to logged-in users). Trial: 2,000 parcels + 10,000
tiles in 30 days. **Per-query cost not captured** — operator will
read the plans page during SCOPE B kickoff to verify the $0.01–
0.05/lookup envelope the dispatch targets.

**Premium vs Standard tier decision** is downstream of vendor pick:
- Standard covers all the must-haves (parcel, zoning, provenance).
- Premium adds standardized zoning taxonomy, FEMA flood overlays,
  LBCS land-use, demographic + elevation derived fields.
- The Premium FEMA flood overlay could partially replace the FEMA
  NFHL adapter (closing one QA-22 federal-layer issue indirectly),
  but FEMA NFHL stays as direct consumer per dispatch scope.

## 4. ATTOM — detail

**Endpoint shape**:
`https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail?latitude=X&longitude=Y&radius=N`
— **radius-based**, NOT point-in-polygon. Default radius 5 miles,
max 20 miles. ATTOM returns properties WITHIN a radius, not THE
parcel containing a point. **Critical functional gap** vs Cortex's
site-context pattern.

**Schema** ([`api.gateway.attomdata.com/docs`](https://api.gateway.attomdata.com/docs)):
- Carries: ATTOM ID, APN, address, owner, beds/baths/sqft, year
  built, assessments, sales history, AVM valuation, school
  district, building permits.
- **Notably absent**: zoning code, zoning description, parcel
  geometry, overlay districts. The "Property Detail" envelope is
  characteristics-centric, not boundary-centric.

**Coverage**: "160 million properties" total; no county-level map
exposed; no Utah/Texas specificity disclosed.

**Pricing**: not documented online. Sales-gated via
`attomdata.com/contact-us/` + phone (800.462.5125). Free trial
account exists but no per-query rate is published.

**Auth**: `APIKey` header.

## 5. CoreLogic — not evaluated

Per dispatch step A.3 ("evaluate only if Regrid + ATTOM both fail"),
CoreLogic recon was skipped. Regrid clearly matches Cortex's
contract; CoreLogic eval would be redundant.

## 6. Decision matrix

| Criterion | Regrid | ATTOM | Notes |
|---|---|---|---|
| Query shape (point-in-polygon) | ✅ | ❌ Radius-based | ATTOM gap is structural for site-context |
| Parcel geometry | ✅ (GeoJSON in response) | ❌ Not documented | |
| Zoning code + description | ✅ Standard tier | ❌ Not documented | |
| Provenance tagging | ✅ (`sourceurl`, `county`, `geoid`, refresh dates) | ⚠️ Cross-county aggregate, less per-county | Dispatch explicit requirement |
| Self-serve pricing | ✅ `app.regrid.com/api/plans` | ❌ Sales-gated | Operational tempo signal |
| Per-query cost in $0.01–0.05 envelope | ⚠️ Unverified (plans page gated) | ❌ Unverified (no public pricing) | Operator verifies for Regrid during SCOPE B kickoff |
| Coverage in target geos (UT, TX) | ⚠️ Nationwide claimed; UT not in trial; needs verification | ⚠️ 160M properties claimed; no UT/TX specificity | Both need empirical check |
| Auth | API key (header) | API key (header) | Equivalent |
| Schema-match for briefing engine | ✅ Direct map | ❌ Major gaps | |
| FEMA flood enrichment | ✅ Premium tier | ❌ Not documented | Indirect QA-22 SCOPE A benefit |

**Recommendation: Regrid**. ATTOM's radius-based shape + missing
zoning/geometry fields rule it out. CoreLogic would only enter if
Regrid coverage testing reveals a fatal Utah/Texas gap during
SCOPE B kickoff.

## 7. Known unknowns the operator should verify before SCOPE B

1. **Exact Regrid point-in-polygon endpoint URL and request shape**
   — fetch from `developer.regrid.com/llms.txt` (OpenAPI spec) or
   the sandbox.
2. **Per-query cost confirmation** — sign into
   `app.regrid.com/api/plans` and confirm the $0.01–0.05/lookup
   envelope holds at Cortex's expected volume (rough envelope:
   1–10 engagements/day × ~5 federal+local adapter calls per
   engagement = 5–50 calls/day = 150–1500/month for the Cortex
   baseline; well under Regrid trial allocation of 2,000/30d).
3. **Standard vs Premium tier pick** — Standard covers MVP; Premium
   adds FEMA flood + LBCS land-use + demographic derivatives that
   reduce other adapter load (FEMA NFHL workflow, etc).
4. **Coverage gap probe** — run a trial-account query for known
   parcels at Musgrave (Moab, Grand County UT), Redd (Moab area),
   and Bastrop TX. Confirm each returns a clean parcel + zoning
   envelope. If Grand County UT comes back empty, the per-county
   adapter (currently QA-22 SCOPE C operator-infra) stays load-
   bearing rather than becoming enrichment-only.

## 8. SCOPE B implementation outline (preview, not in this PR)

Per dispatch:

- New `lib/adapters/src/national/regrid.ts` following the
  federal-adapter pattern. Structured logging via the
  `regridLogEvent(level, msg, fields)` pattern from PR #96's
  `fccLogEvent`.
- Add to the site-context runner as **baseline** parcel + zoning
  source for ALL engagements.
- Per-county adapters (`grand-county-ut:*`, `bastrop-tx:*`, …)
  become **opportunistic enrichment** — fire only when a
  `partner_city` flag is set on the engagement jurisdiction.
- Source-agnostic consumer — emit the same
  `payload.parcel.{geometry, attributes}` and
  `payload.zoning.{geometry, attributes}` shape the existing
  consumers (overlays.ts, ParcelZoningCard, briefing-engine
  prompt) already read.
- One adapter call returns both parcel + zoning; emit as
  **two `briefing_sources` rows** (one parcel, one zoning) to
  match the existing per-county adapter convention. Alternative
  considered: one combined source with both `payload.parcel` and
  `payload.zoning` keys — deferred; the two-row pattern fits
  existing consumer code with zero downstream change.
- Cache: leverage existing 24h Postgres
  `adapter_response_cache` (federal-tier-default predicate
  already covers federal tier; Regrid is national-tier, so the
  predicate may need a one-line update OR a new
  `nationalAdapterCachePredicate`). PR #94's 15-min in-memory
  layer pattern from FCC can be replicated for Regrid.
- Vendor key: `REGRID_API_KEY` as Cloud Run secret; operator
  provisions before deploy.
- Tests: 6 minimum per dispatch (happy / no-coverage /
  upstream-error / cache-hit / partner-city enrichment /
  non-partner skip).

## 9. SCOPE C preview (after SCOPE B closes)

Per dispatch:
- Grand County GIS QA-22 operator-infra (VPC + Cloud NAT +
  whitelist) goes from **required** → **optional**. Only worth
  pursuing if Grand County GIS adds enrichment Regrid doesn't
  (flood districts, county-specific overlays). Premium tier
  Regrid FEMA flood may make this fully optional.
- FCC + EPA decisions **stand independently** — broadband +
  environmental justice are different data domains Regrid doesn't
  cover. QA-22 FCC recon (PR #96 / #97) and QA-22 SCOPE A EPA
  recommendation are unaffected.

## 10. Workspace hygiene

- Branch off `origin/main` HEAD = `4aa3d2a` (includes
  cortex-api PR #98 USGS 3DEP DEM raster client) in isolated
  worktree (`p:/tmp/cortex-regrid-eval`) per the workspace-
  hygiene memory.
- No code change in SCOPE A; docs PR only.
- No commits to `doc_repo`. This file is the durable copy in
  `legacy-design-tools/_research/`; the inbox drop at
  `doc_repo/_inbox/2026-05-23_legacy-design-tools_cc-agent-C_cortex_regrid_evaluation.md`
  is file-only per HR-11.
