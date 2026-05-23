---
session_id: 2026-05-23_cortex_prop_intel_regrid_eval
author: cc-agent-C2
date: 2026-05-23
dispatch: cortex-prop-intel-regrid-eval (SCOPE A, vendor evaluation)
doctrine: P:\doc_repo\_decisions\2026-05-23_partnership_first_scoping.md
related_canonical: [40d_cortex_site_context_sprint, 43_cortex_qa_backlog, 46_smartcity_parcel_intelligence]
status: recommendation-pending-operator-approval
---

# Cortex prop-intel — Regrid + ATTOM vendor evaluation (SCOPE A)

> **TL;DR — Recommend Regrid as the Cortex national parcel + zoning
> baseline source.** Strong schema fit, full UT + TX coverage, monthly
> rolling updates, developer-friendly token-auth + GeoJSON response,
> self-serve plans in the $500–$2,000/mo range. ATTOM is the credible
> fallback but its strengths (sales / mortgages / 9,000 attributes per
> property) sit outside Cortex's architect-facing briefing surface.
> CoreLogic skipped per dispatch gate — both Regrid and ATTOM are
> viable, so the enterprise-pricing tier never opens.

## Doctrine context

The 2026-05-23 [Partnership-first scoping decision](../../doc_repo/_decisions/2026-05-23_partnership_first_scoping.md)
settled that Cortex product-baseline data sourcing is OUT of scope for
the Partnership-first commitment. National public-records aggregators
(Regrid, ATTOM, CoreLogic) are fair game. The Hauska substrate +
Bastrop + partner-city work is unchanged.

The recon that drove this evaluation: per-county GIS adapters do not
scale. Grand County GIS firewalls Cloud Run egress (QA-22 SCOPE C);
EPA EJScreen is decommissioned (QA-22 SCOPE A); FCC broadbandmap is
Akamai-WAF-gated (QA-22 SCOPE B mitigation landed in PR #94 + #96).
Operationally infeasible to negotiate per-IP whitelisting at the
~3,143 US-county scale Cortex needs.

## Goal of this evaluation

Pick a national parcel + zoning baseline vendor to replace the
per-county GIS adapter pattern (Grand County GIS + future county
adapters). Per-county adapters become opportunistic enrichment for
partner cities (Bastrop) only.

## Decision criteria (from the dispatch)

1. **Coverage gaps** for the operator's target geographies — UT (the
   Musgrave + Redd engagements) and TX (Bastrop + the Sync 5 corridor
   cities).
2. **Pricing fit** for Cortex's per-engagement cost envelope. The
   sprint's USGS 3DEP DEM ingest is on the order of $1–5 per
   engagement compute; parcel lookup should be a fraction of that.
3. **Schema match** for what the briefing engine consumes —
   `payload.parcel.geometry`, `payload.parcel.zoning_code`,
   `payload.parcel.overlays`, etc.
4. **Provenance tagging** — every record carries source-county +
   acquisition timestamp, per the dispatch's explicit requirement.

## Consumer-side contract audit (`legacy-design-tools-c2`, main @79b5208)

The contract a national parcel adapter has to satisfy is narrower than
it looks at first read:

- **`lib/site-context/src/client/overlays.ts`** (the SiteMap overlay
  extractor) is the ONE structured consumer. It reads
  `payload.parcel.geometry` and `payload.zoning.geometry` as ArcGIS-
  rings polygon shapes (`geometry.rings: [[[x,y], …]]` with
  `geometry.spatialReference.wkid`). All current adapters
  (`grand-county-ut:parcels`, `ugrc:parcels`) emit this shape because
  they're hitting ArcGIS REST services upstream.
- **`lib/briefing-engine/src/prompt.ts`** treats `payload` as opaque
  JSON, serializes it (capped at 4000 chars), and hands it to Claude
  Sonnet 4.5 as part of the per-engagement source bundle. The engine
  has NO structured-field requirement — the LLM does semantic
  interpretation. This means a Regrid GeoJSON payload passes through
  unchanged on the briefing-engine side; the only translation work
  is `overlays.ts`.
- **`artifacts/api-server/src/atoms/briefing-source.atom.ts`** is
  shape-only (DA-PI-1 sprint — fetch/refresh layer ships in DA-PI-3).
  No payload schema enforcement.
- **Site-topography ingest** (in flight — Phase 2D.1.2, currently
  paused for this evaluation) needs parcel boundary geometry to
  compute the parcel + upstream-catchment DEM bbox. Format-agnostic
  if the ingest worker can read either GeoJSON or ArcGIS rings.

**Implication:** the vendor-format question reduces to "does
`overlays.ts` need to grow a GeoJSON branch?". If the vendor returns
GeoJSON (Regrid does), the integration PR adds 1 function to
`overlays.ts` that handles GeoJSON Polygon / MultiPolygon alongside
the existing ArcGIS rings path. If the vendor returns ArcGIS rings
(ATTOM does too via its Boundary API), `overlays.ts` is untouched.
Both are tractable; ~half a day of work either way.

## Vendor evaluation

### Regrid (regrid.com)

**Coverage.** 159 million parcel boundaries + records across 3,229
counties, ~99% of Americans by population. Utah: **all 29 counties
covered** (Utah has 29 counties total, so this is full state coverage
including Grand County). Texas: nationwide coverage; specific Sync 5
corridor city verification deferred to the trial-period smoke test in
SCOPE B. Zoning coverage in **2,500+ counties** spanning **13,900+
municipalities** — explicitly applies to the standardized
zoning_type/zoning_subtype fields, not just raw zoning codes.

**API surface.**
- **Endpoint**: `GET https://app.regrid.com/api/v2/parcels/point?lat=<lat>&lon=<lon>&token=<token>`
- **Auth**: API token via query parameter (or Authorization header). Single env var: `REGRID_API_KEY`.
- **Other v2 endpoints**: `/api/v2/parcels/address`, `/api/v2/parcels/apn`, `/api/v2/parcels/owner`, `/api/v2/parcels/query` (multi-filter), `/api/v2/parcels/area` (polygon-search).
- **Response format**: GeoJSON FeatureCollection envelope:
  ```json
  {
    "parcels": {
      "type": "FeatureCollection",
      "features": [
        {
          "type": "Feature",
          "geometry": { "type": "Polygon", "coordinates": [[[-109.55, 38.57], …]] },
          "properties": {
            "headline": "440 Burroughs St",
            "fields": { /* 120+ parcel data fields per the schema */ }
          },
          "id": 364491
        }
      ]
    }
  }
  ```
- **Query params**: `lat`, `lon`, `radius` (default 0m, max 32km), `limit` (default 20, max 1000), `return_geometry` (default true), `return_count`, `geojson` (alternative input — GeoJSON Point / MultiPoint geometry; takes priority over lat/lon if both are sent).
- **Batch processing**: `/api/v2/parcels/batch` endpoint exists for bulk lookups (relevant for the briefing-precompute path).

**Schema** (per
[support.regrid.com/parcel-data/schema](https://support.regrid.com/parcel-data/schema)):

| Cortex need | Regrid Standard | Regrid Premium |
|---|---|---|
| Parcel polygon geometry | `geometry` (GeoJSON Polygon) | same |
| Owner | `owner`, `ownfrst`, `ownlast`, `previous_owner` | same |
| Zoning code (raw) | `zoning` | (also `zoning_id`) |
| Zoning description | `zoning_description` | same |
| Standardized zoning type | — | **`zoning_type`** (e.g. "residential", "commercial") |
| Standardized zoning subtype | — | **`zoning_subtype`** (e.g. "single-family") |
| Zoning code URL | — | **`zoning_code_link`** (municipality code link) |
| Acquisition timestamp | `ll_last_refresh` | same |
| Mutation timestamp | `ll_updated_at` | same |
| County source URL | `sourceurl` (county portal) | same |
| Lat/lng centroid | `lat`, `lon` | same |

**Overlays gap.** The schema does NOT document a dedicated "overlay
districts" field. `overlays.ts` references `payload.parcel.overlays`
as one consumer-side key, but the existing adapters don't actually
populate it either (they pass through `payload.parcel = ArcGisFeature`
with attributes inline). The Regrid integration would mirror that:
overlay-district data is part of `properties.fields` if the source
county publishes it; otherwise absent. This is unchanged from the
status quo and not a new gap.

**Provenance.** Strong: `ll_last_refresh` (county-data acquisition
date), `ll_updated_at` (row mutation), `sourceurl` (the county portal
URL the data was scraped/sourced from). No `source_county` field per
se, but `county_id` / FIPS fields fill that role. **Sufficient for
the dispatch's "every record should carry source-county and
acquisition timestamp" requirement.**

**Updates.** Rolling **monthly** refresh per county. The
`ll_last_refresh` field carries the county-specific date. Compares
favorably with ATTOM's quarterly cadence on zoning data.

**Pricing.**
- **Self-serve tiers**: published as starting in the $500–$2,000/mo
  range depending on schema (Standard vs Premium) and call quota.
  Hybrid model: fixed base + per-call overage above the included
  quota; account dashboard exposes a monthly maximum-spend cap.
- **Free trial**: 7-day. Sufficient to validate UT + TX coverage on
  the actual Musgrave + Redd + Bastrop parcels before billing starts.
- **Typeahead API** (autocomplete, distinct from parcel lookup):
  $0.001/request, confirming Regrid is comfortable with per-call
  unit economics at that scale; parcel-lookup overage rates are not
  publicly listed but expected in the $0.01–0.05/lookup range per the
  dispatch's target.
- **Enterprise**: custom pricing above self-serve, only worth
  pursuing if call volume exceeds the $2k/mo plan's ceiling.

**Developer-friendliness.** Token-auth + REST + GeoJSON FeatureCollection
response is a ~1-day adapter integration. Existing `lib/adapters`
patterns transfer cleanly: `fetchWithRetry` for transient hiccups,
`AdapterRunError` taxonomy, `adapter_response_cache` for the 24h
default federal-tier cache, the 15-min in-memory cache from PR #94.

### ATTOM Data Solutions (attomdata.com)

**Coverage.** 160 million properties, claims 99% of US population.
Parcel-boundary specific coverage is in their dedicated Boundary Data
product. Specific UT + TX coverage per-county not publicly verifiable
without a trial; community sources flag ATTOM as strongest in major
metros and weaker in rural counties (relevant for Musgrave in Moab UT
and Redd in Grand County — both rural-adjacent).

**API surface.**
- Developer platform at `api.developer.attomdata.com`. Free 30-day
  trial with API key.
- REST + JSON/XML. Boundary data available in GeoJSON, also Shapefile,
  GeoParquet, EWKT (more delivery flexibility than Regrid).
- Specific point-in-polygon endpoint path not surfaced in the
  documentation overview without a trial sign-up; sources confirm
  lat/long lookup is supported.

**Schema.** Far broader than Regrid: 9,000+ attributes per property
including sales history, mortgage info, foreclosure data, tax
assessments, comparables, schools, crime, demographics. For Cortex's
architect-facing briefing surface, **most of these attributes are
noise**. Zoning is included but disclosure is shallower than Regrid's
standardized-zoning_type/subtype offering.

**Provenance.** Quarterly refresh cadence on parcel boundaries (vs
Regrid's monthly). Specific per-county acquisition-date field not
documented as cleanly as Regrid's `ll_last_refresh`; would need
trial-period verification.

**Pricing.**
- Starts at **$95/month** for entry-level developer tier.
- Example tier: **$1,000/month for 100,000 API Reports** at
  **$0.10/report**. "API Reports" are billing units; one HTTP call
  can yield multiple reports.
- Free 30-day trial (longer than Regrid's 7-day).
- Enterprise plans for larger volumes; community sources note ATTOM
  enterprise pricing as "complex and time-consuming" to negotiate
  and "may be prohibitive" for non-enterprise customers.

**Developer-friendliness.** Solid (REST + JSON, free trial, public
endpoint catalog) but with a heavier enterprise-sales motion above
the entry tier. Schema is generic-real-estate-API shaped (Estated /
ATTOM merger lineage) which leaves Cortex extracting a narrow slice
of a much bigger surface.

### CoreLogic (corelogic.com) — gated, not evaluated

Per dispatch: "evaluate only if Regrid + ATTOM both fail." Neither
fails. CoreLogic is an enterprise-only contract path (subscription +
per-call charges starting at amounts that can "quickly exceed
budgets"); skipped.

## Side-by-side

| Criterion | Regrid | ATTOM | Verdict |
|---|---|---|---|
| US parcel coverage | 159M / 3,229 counties / 99% pop | 160M / ~99% pop | Tie |
| UT counties | **All 29** | 99% pop (rural verification needed) | **Regrid clear** |
| TX coverage | Nationwide | Nationwide | Tie |
| Zoning standardization | **`zoning_type` + `zoning_subtype`** | Generic "zoning classifications" | **Regrid clear** |
| Zoning county coverage | 2,500+ counties | Not disclosed | **Regrid clear** |
| Geometry format | GeoJSON Polygon | GeoJSON / Shapefile / GeoParquet / EWKT | ATTOM more flexible; not load-bearing |
| Refresh cadence | **Rolling monthly** | Quarterly | **Regrid clear** |
| Schema purpose-fit for Cortex | Parcel + zoning native | Parcel as a subset of 9,000-attr real-estate data | **Regrid clear** |
| Pricing entry | $500/mo (estimate) | $95/mo | ATTOM cheaper at entry |
| Pricing tier ceiling (self-serve) | $2,000/mo | $1,000/mo for 100k reports | ATTOM cheaper at scale |
| Free trial | 7 days | 30 days | ATTOM more generous |
| Auth + integration | Token query param, ~1 day | API key, comparable | Tie |
| Developer-friendliness | GIS-native docs, self-serve | Enterprise sales bias above entry | Slight Regrid edge |
| Provenance fields | `ll_last_refresh` + `sourceurl` | Quarterly batch; per-county date TBD | **Regrid clear** |

## Recommendation: **Regrid**

The pricing edge ATTOM has at entry tier ($95 vs $500) does not
overcome Regrid's substantive lead on schema fit (standardized zoning
that maps directly to Cortex's briefing engine inputs), update cadence
(monthly vs quarterly — material when a council meeting can amend a
setback), and rural-county coverage (Moab + similar markets are
Regrid's strength and ATTOM's risk). The $500/mo entry difference is
within one Empressa engagement's gross margin band; pricing is not
the load-bearing factor at the operator's projected volume.

A pragmatic pricing posture for the pilot phase:
1. Start on the **7-day free trial** to verify Musgrave_Residence_B
   (Moab UT) and Redd (Grand County UT) parcels return clean polygon
   + zoning_type + ll_last_refresh.
2. Move to the **Standard schema, lowest paid tier** (~$500/mo
   estimated) to put the integration into production behind a
   feature flag.
3. Upgrade to **Premium schema** ($1,500–$2,000/mo estimate) once
   Cortex usage justifies the standardized-zoning_type fields and
   the per-municipality zoning_code_link is referenced from the
   briefing engine.

If the pilot volume blows the $2k/mo self-serve ceiling, **revisit
ATTOM at the $0.10/report tier as the volume-pricing fallback**, not
because ATTOM is better but because it's cheaper at >50k engagements/mo
(which would itself be excellent operational news).

## Reversal criteria

Trigger reconsideration if:

1. **Regrid pricing for the operator's actual call volume exceeds
   Cortex's cost envelope after the trial.** Revisit ATTOM at the
   $0.10/report tier. Mechanism: 1-month trial billing log against
   actual engagement volume.
2. **Regrid's overlay-district gap blocks a P0 use case** — e.g. a
   historic-district overlay materially affecting setbacks where
   Regrid's zoning_type doesn't surface the overlay. Mitigation:
   per-county GIS (now opportunistic) handles overlay enrichment
   for that jurisdiction. ATTOM unlikely to fill the gap differently.
3. **A partner-city's local GIS materially outperforms Regrid** for
   that city's zoning. Bastrop's UDC ingest is a separate
   substrate-side pipeline (per Partnership-first); local GIS for
   partner cities continues as opportunistic enrichment with
   `partner_city = true` flag.
4. **Regrid coverage gap surfaces in a target Sync 5 corridor city
   in TX**. Mitigation: per-county GIS for that city only; do not
   abandon Regrid baseline.
5. **Regrid's `ll_last_refresh` cadence drifts below 6 months on a
   target jurisdiction**. Refresh-staleness windows in the existing
   adapter code (e.g.
   `GRAND_COUNTY_PARCELS_FRESHNESS_THRESHOLD_MONTHS = 6`) become
   the gate; surface the amber stale badge on the Site Context tab.

## Schema-fit notes for SCOPE B integration (after operator approval)

When SCOPE B fires, these are the concrete contract points:

**1. Adapter placement.** `lib/adapters/src/national/regrid.ts` as
the dispatch specifies. Existing `lib/adapters` package conventions
apply: `Adapter` interface (
[lib/adapters/src/types.ts](../lib/adapters/src/types.ts)), `tier:
"federal"` (closest fit — no `national` tier exists today; either
add `"national"` to `AdapterTier` or treat Regrid as federal-tier).

**2. Two adapters or one?**
- Option A: a single `regrid:parcel-and-zoning` adapter that emits
  one briefing-source row carrying both `payload.parcel` and
  `payload.zoning`. Simpler; one API call covers both.
- Option B: separate `regrid:parcels` and `regrid:zoning` adapters
  that share an HTTP-level cache. Mirrors the existing
  `grand-county-ut:parcels` / `grand-county-ut:zoning` split; UI
  tier-toggles stay per-layer.
- **Recommend B** — Site Context tab's per-layer pills work
  cleanly today; preserving that affordance is operator-friendly,
  and the deduplicated HTTP cache means the cost is one upstream
  call per engagement regardless.

**3. Payload shape.** Regrid returns GeoJSON Polygon, not ArcGIS
rings. Two paths, **prefer (b)**:
- (a) Convert GeoJSON → ArcGIS rings inside the adapter. 30-line
  helper. Preserves `overlays.ts` unchanged.
- (b) Extend `overlays.ts`'s
  `extractBriefingSourceOverlays(sources)` to also recognize
  GeoJSON Polygon / MultiPolygon under `payload.parcel.geometry.type
  === "Polygon"` or `payload.parcel = <GeoJSON Feature>`. Cleaner
  long-term: future federal/national adapters will mostly emit
  GeoJSON, so the per-adapter format-conversion burden disappears.
  Unit-test cost is +3–5 cases on the existing overlays test suite.

**4. Provenance mapping.**
- `briefing_sources.snapshot_date` ← Regrid `ll_last_refresh` (the
  county-specific acquisition timestamp).
- `briefing_sources.provider` ← `"Regrid"` (or
  `"Regrid (via <source-county>)"` for the human-readable label).
- `briefing_sources.layer_kind` ← `"regrid-parcel"` /
  `"regrid-zoning"`.
- `briefing_sources.source_kind` ← new value
  **`"national-aggregator"`** (or reuse `"federal-adapter"`; new
  value is cleaner for the doc-repo audit trail and the SiteMap
  tier color separation).

**5. Cache.** The existing 24h Postgres `adapter_response_cache`
table (federal-tier default per
[lib/adapters/src/cache.ts](../lib/adapters/src/cache.ts)) and the
15-min in-memory cache from PR #94 both apply unchanged. Regrid
queries are deterministic on lat/lng, so cache hit rate after the
first engagement on a parcel is 100% until `ll_last_refresh` rolls
forward.

**6. Runner wiring.** Per the dispatch:
- Regrid fires for ALL geocoded engagements as the parcel + zoning
  baseline.
- Per-county adapters (`grand-county-ut:*`) gate behind a
  `partner_city = true` flag on the engagement jurisdiction. For
  non-partner jurisdictions, the per-county adapter is skipped
  entirely. Bastrop, TX will have `partner_city = true`; Grand
  County, UT currently does not — meaning under SCOPE B, Grand
  County's adapters DEPRECATE as baseline (kept in tree, gated
  off). Mark the file header with a "deprecated as baseline"
  doc-comment per the dispatch.

**7. Tests.** Per the dispatch's stated minimum 6 cases:
- Happy path (parcel + zoning returned)
- No-coverage (lat/lng outside vendor coverage, e.g. mid-Atlantic
  ocean test)
- Upstream-error (timeout, 5xx, malformed)
- Cache hit (no upstream call)
- Partner-city enrichment path (per-county + Regrid both fire,
  briefing-source contains both rows)
- Non-partner skip path (only Regrid fires, per-county skipped)

**8. Env vars.** `REGRID_API_KEY` as a Cloud Run secret. Operator
provisions before deploy. Note: secret seeding for cortex-api on
Cloud Run is operator-side per the QA-04 Part 2 manual psql apply
precedent.

## SCOPE C — Federal layer reconciliation (out of this session's scope)

After SCOPE B lands, the dispatch re-evaluates QA-22 work:
- **EPA EJScreen** (SCOPE A): unchanged decision — different domain
  (environmental justice), Regrid doesn't cover it.
- **FCC broadbandmap** (SCOPE B): unchanged — different domain
  (broadband), Regrid doesn't cover it. PR #94 (90s timeout floor)
  + PR #96 (structured logging) stand.
- **Grand County GIS** (SCOPE C): VPC + Cloud NAT + whitelist
  outreach drops from REQUIRED to OPTIONAL. Only worth pursuing if
  Grand County publishes overlay districts (e.g. floodplain overlay
  zones) that Regrid does not surface AND a customer-zero case
  surfaces that need. Default disposition: defer indefinitely.

## Sources

- [Regrid Parcel API overview](https://regrid.com/api)
- [Regrid Parcel API endpoints (v2)](https://support.regrid.com/api/parcel-api-endpoints)
- [Regrid Parcel Schema](https://support.regrid.com/parcel-data/schema)
- [Regrid Standardized Zoning](https://support.regrid.com/parcel-data/zoning)
- [Regrid Self-Serve API Plans](https://app.regrid.com/api/plans)
- [Regrid Utah parcel data store](https://regrid.com/utah-parcel-data)
- [ATTOM Developer Platform](https://api.developer.attomdata.com/home)
- [ATTOM Parcel Boundary Data](https://www.attomdata.com/data/boundaries-data/parcel-boundaries/)
- [Realie.ai property data API comparison](https://blog.realie.ai/blog/exploring-the-best-u-s-property-data-apis-and-their-drawbacks)
- [Partnership-first scoping decision (2026-05-23)](../../doc_repo/_decisions/2026-05-23_partnership_first_scoping.md)
- Codebase audit: legacy-design-tools-c2 @ main 79b5208 — `lib/site-context/src/client/overlays.ts`, `lib/briefing-engine/src/prompt.ts`, `lib/briefing-engine/src/types.ts`, `lib/adapters/src/types.ts`, `lib/adapters/src/local/grand-county-ut.ts`, `artifacts/api-server/src/atoms/briefing-source.atom.ts`.

## Hand-off

- **Decision pending operator approval**: Regrid pick.
- **Next step (operator-side)**: confirm the recommendation; sign up
  for the 7-day Regrid trial; verify Musgrave (1144 N Kayenta Dr,
  Moab UT) + Redd parcels return clean polygon + zoning_type +
  ll_last_refresh through the trial API token.
- **Next step (cc-agent-C2)**: on operator approval, fire SCOPE B —
  build `lib/adapters/src/national/regrid.ts` (or whichever tier the
  operator prefers), extend `overlays.ts` for GeoJSON Polygon, wire
  to the site-context runner, deprecate `grand-county-ut:*` as
  baseline behind `partner_city` flag, ship with the 6 test cases.
- **Parallel track (cc-agent-C2)**: 2D-site-context Phase 2D.1 PR2
  (site-topography atom + DEM ingest worker, off PR #98's USGS 3DEP
  client) resumes after the Regrid decision lands. The DEM ingest
  worker consumes the same `payload.parcel.geometry` contract Regrid
  will produce — sequencing Regrid first means PR2 reads from the
  national baseline without a per-jurisdiction fallback path, which
  is simpler.
