# QA-22 SCOPE A — EPA EJScreen v2 targeted dig

**Date:** 2026-05-23
**Agent:** cc-agent-C
**Branch:** cortex/qa22-epa-dig (worktree-cortex+qa22-epa-dig at creation; rename pending if a PR is opened by the operator)
**Verdict:** **MISS at the EPA layer.** No EPA-published successor to the EJScreen broker exists at this time. A third-party state-agency-hosted mirror of the EJScreen 2023 archive does exist and preserves the full indicator schema, but it is not an EPA endpoint and ships state-distribution percentiles rather than the US-distribution percentiles the original broker returned. The EPA pill remains red on Redd until EPA publishes a v2; the operator has the option to opt into the third-party mirror documented below if state-percentile semantics + a state-agency dependency are acceptable.

## What changed in the repo

1. `lib/adapters/src/federal/epa-ejscreen.ts` top-of-file docstring rewritten to record:
   - The decommission status (DNS gone, homepage 404, broker TCP-refused)
   - The sweep ledger so a future agent does not re-dig the same ground
   - The CalEPA-hosted fallback mirror as a noted (NOT enabled) option
   - A pointer back to this note for the full evidence trail
2. This session note in `_research/`.
3. No behavior change. No PR filed (per dispatch: "If MISS, no PR — just the docstring update + session note.").

## What the old broker consumed

`epa-ejscreen.ts` previously called `https://ejscreen.epa.gov/mapper/ejscreenRESTbroker3.aspx` with a WGS84 point geometry and read 5 indicators from the `data.main` envelope keyed by EJScreen field names:

| Indicator (briefing-engine field)       | Old broker field key       |
| --------------------------------------- | -------------------------- |
| Block-group total population            | `RAW_D_POP`                |
| Demographic-index percentile            | `P_D2_VULEOPCT`            |
| PM2.5 percentile                        | `P_PM25`                   |
| Ozone percentile                        | `P_OZONE`                  |
| Lead-paint percentile                   | `P_LDPNT`                  |

Everything else was passed through verbatim on `payload.raw`.

## Decommission confirmation (independent of dispatch's pre-known DNS NXDOMAIN)

| URL                                                       | Result                              |
| --------------------------------------------------------- | ----------------------------------- |
| `https://ejscreen.epa.gov/mapper/`                        | ECONNREFUSED at TCP (host gone)     |
| `https://www.epa.gov/ejscreen`                            | HTTP 404                            |
| `https://www.epa.gov/ejscreen/download-ejscreen-data`     | HTTP 404                            |
| `https://www.epa.gov/ejscreen/learn-more-about-ejscreen`  | HTTP 404                            |
| `https://catalog.data.gov/dataset/ejscreen`               | HTTP 404                            |

Conclusion: EPA has fully removed EJScreen from public-facing infrastructure (DNS, web pages, REST endpoints, data.gov pointers). This is not a partial migration; it is a full retirement.

## EPA ArcGIS REST sweep (geopub + gispub)

Root-catalog folder listings retrieved from both servers:

- **geopub.epa.gov/arcgis/rest/services** — 28 folders: `aquiferexem, EMEF, ER_R4, icr, monitor, myenv, NEF, NEPAssist, NEPmap, OCSPP, OECA, OECAenforcement, OLEM, OLEM_FedFac, OLEM_WTD, OPP, ORD, OW, OWOWM, pesticide, r1, R2, R3, R9, RadMap, Utilities, UW, WOUS`. No services at root.
- **gispub.epa.gov/arcgis/rest/services** — 25 folders: `AgSTAR, ER_Harvey, monitor, NELP, NPDAT, OA, OAR_OAP, OAR_OAQPS, OCSPP, OECA, OEI, ORD, OSWER, OW, PrintTools, R1, R10, R1AUL, r4, r6, R9MarineDebris, R9Watersheds, Region9, TEST, Utilities`. One root-level service (`SampleWorldCities`, Esri default). No EJ.

Six folders probed (selected by EJ-relevance of the office acronym):

| Folder                       | Match? | Finding                                                                                                       |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `gispub/ORD`                 | ✗      | 33 MapServers — Environmental Quality Index, Human Well-Being Index, Reports-on-the-Environment. Different methodology, different schema. No EJ. |
| `gispub/OEI`                 | ✗      | ACS demographics tract layers from 2010 + 2012 (stale Census, no pollution indicators); TRI National Analysis 2013–2020 (toxic-release facilities, not block-group percentiles). |
| `gispub/OECA`                | ✗      | 5 MapServers — enforcement annual reports + CAFO density. No EJ.                                              |
| `geopub/NEPAssist`           | ✗      | 10 MapServers including `NEPAVELayersPublic_fgdb` (42 layers, see below) — NAAQS non-attainment polygons, not block-group percentiles. |
| `geopub/myenv`               | ✗      | 2 MapServers: AQI + a general overlay aggregator. No EJ.                                                       |
| `gispub/OAR_OAQPS`           | ✗      | 50+ MapServers — NAAQS non-attainment, NATA 2014, design values. Pollutant surfaces, not block-group percentile schema. |

`NEPAssist/NEPAVELayersPublic_fgdb` looked promising on the folder list (it had been observed that NEPAssist's UI surfaces EJScreen overlays for federal-agency NEPA reviewers). Layer drill-down (42 layers including `ozone_8_hr_2015_standard`, `pm2_5_annual_2012_standard`, `lead_2008_standard`, etc.) showed that the air-quality layers are **non-attainment-area polygons** (categorical: yes/no this point sits in an EPA-designated non-attainment area for pollutant X), **not** the per-block-group **percentile** schema the EJScreen broker returned. The NEPAssist UI must compose these against a separate, non-publicly-exposed EJScreen layer. Wrong semantics for our consumer.

Folders not probed (low EJ probability based on acronym decode): `aquiferexem, EMEF, ER_R4, icr, monitor, NEF, NEPmap, OCSPP, OECAenforcement, OLEM*, OPP, OW, OWOWM, pesticide, r1, R2, R3, R9, RadMap, UW, WOUS` (geopub) and `AgSTAR, ER_Harvey, NELP, NPDAT, OA, OAR_OAP, OCSPP, OSWER, OW, R1, R10, R1AUL, r4, r6, R9MarineDebris, R9Watersheds, Region9` (gispub). These decode to non-EJ EPA functions (chemical safety, regional waste, marine debris, pesticide, federal facilities, etc.). A truly exhaustive sweep would crawl every folder; this was a targeted dig.

`edg.epa.gov/data/PUBLIC/OEI/` (the EPA Enterprise Geospatial Data archive root for the Office of Environmental Information) was also probed: 17 directories (Backup, CongressionalDistricts, EMEProFiles…) and 2 files. No EJScreen archive.

## EPA Esri Online org search for "EJScreen"

`https://epa.maps.arcgis.com/sharing/rest/search?q=EJScreen&...` returned 8 results, all third-party publications:

| # | Title                                                            | Owner                  | Hosting org                              | Note                                                            |
| - | ---------------------------------------------------------------- | ---------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| 1 | DE EJScreen                                                      | FirstMap@De            | enterprise.firstmap.delaware.gov         | Delaware state subset                                            |
| 2 | EJScreen Supplemental Index US Percentiles 2023                  | DominiqueP             | services1.arcgis.com/7iJyYTjCtKsZS1LR    | Supplemental index methodology only (subset of indicators)       |
| 3 | EJScreen Supplemental Index MA Percentiles 2024                  | DominiqueP             | services1.arcgis.com                     | Massachusetts state subset                                       |
| 4 | **EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb**             | **1045138_CAL**        | services2.arcgis.com/iq8zYa0SRsvIFFKz    | **Full 2023 BG archive + territories — see schema match below**  |
| 5 | DEQ Virginia EJScreen                                            | april.nimary_VADEQ     | Virginia-DEQ                              | Web map, state subset                                            |
| 6 | EJScreen EJ Index for PM2.5 (Compared to State)                  | Aidan_UtahCleanEnergy  | ejscreen.epa.gov (DEAD HOST)             | Result references the dead host                                  |
| 7 | EJScreen total categories exceeded                               | smanderson2_ncdenr     | services2.arcgis.com/kCu40SDxsCGcuUWO    | NC watershed-scoped                                              |
| 8 | EJPRIORITYAREAS_2019_NBEP2021                                    | NBEP_GIS               | services6.arcgis.com                     | Narragansett Bay regional, derived index                         |

Only result #4 is national-coverage with full BG indicator schema. The others are state subsets, derived indices, or stale references to the dead host.

## Schema match — CalEPA-hosted EJSCREEN_2023 mirror (result #4)

**Service URL:** `https://services2.arcgis.com/iq8zYa0SRsvIFFKz/arcgis/rest/services/EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb/FeatureServer/0`
**Layer name:** `EJSCREEN_StatePctiles_with_AS_CNMI_GU_VI`
**Geometry:** `esriGeometryPolygon` (block groups, WKID 4326)
**Modified:** 2024-01-29 (~16 months stale as of this dig)

| Old broker field (consumed) | New field in 2023 mirror | Semantic match? |
| --------------------------- | ------------------------ | --------------- |
| `RAW_D_POP`                 | `ACSTOTPOP`              | yes (rename only — both are ACS-sourced raw block-group total population) |
| `P_D2_VULEOPCT`             | `P_DEMOGIDX_2`           | partial — same family (demographic-index percentile, 2-component), but the methodology refresh between EJScreen 2022 and 2023 redefined the index components (vulnerable + low-income + people-of-color → people-of-color + low-income). Values are NOT directly comparable to historical readings, but the indicator IS present. |
| `P_PM25`                    | `P_PM25`                 | name verbatim; semantics shifted from US-distribution percentile to **state-distribution** percentile (layer is named `BG_StatePct`) |
| `P_OZONE`                   | `P_OZONE`                | name verbatim; same state-percentile semantics shift                       |
| `P_LDPNT`                   | `P_LDPNT`                | name verbatim; same state-percentile semantics shift                       |

**5/5 indicators present.** Two renames (population, demographic index). Most-significant delta: **percentiles are state-distribution, not US-distribution.** A `P_PM25=78` from this mirror means "78th percentile of PM2.5 within this state", whereas the old broker's `P_PM25=78` meant "78th percentile of PM2.5 nationwide". For a Utah block group with PM2.5 near the state's higher end, the state percentile will read HIGHER than the US percentile. This changes how the briefing engine should interpret the value (relative to which population).

## Moab UT live query result (proof of queryability)

```
GET https://services2.arcgis.com/iq8zYa0SRsvIFFKz/arcgis/rest/services/EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb/FeatureServer/0/query
  ?geometry=-109.5498,38.5733
  &geometryType=esriGeometryPoint
  &inSR=4326
  &spatialRel=esriSpatialRelIntersects
  &outFields=ID,STATE_NAME,ACSTOTPOP,P_DEMOGIDX_2,P_DEMOGIDX_5,P_PM25,P_OZONE,P_LDPNT
  &returnGeometry=false
  &f=pjson
```

Returned one feature:
- `ID = 490190002004` (Utah FIPS 49 / Grand Co FIPS 019 / tract 0002.00 / BG 4)
- `STATE_NAME = Utah`
- `ACSTOTPOP = 1179`
- `P_DEMOGIDX_2 = 83`
- `P_DEMOGIDX_5 = 79` (supplemental 5-component variant)
- `P_PM25 = 3`
- `P_OZONE = 4`
- `P_LDPNT = 76`

The query mechanics are familiar ArcGIS REST. Operator can confirm in browser at the URL above.

## Why this is MISS rather than HIT/PARTIAL HIT

The dispatch's verdict criteria are written about **indicator coverage** ("HIT = full schema match; PARTIAL = subset of indicators"). On indicator coverage alone, the CalEPA mirror is at 5/5 and would clear the HIT bar.

But the dispatch's operator-facing intent is clearly "find an EPA successor". Three deltas push this finding off the HIT shelf and into the "MISS at EPA layer / opt-in fallback exists" bucket:

1. **Not EPA-owned.** Hosted on a third-party ArcGIS Online tenant (`services2.arcgis.com`, owner `1045138_CAL`). Could be taken down or stop refreshing without notice; will not be refreshed when EPA publishes a 2024+ EJScreen update (because EPA isn't publishing). Federal-tier promise on Redd is intentionally read as "federal-source data" — a state-hosted mirror weakens that promise.
2. **State percentiles, not US percentiles.** Layer is `BG_StatePct`. The semantic shift from nationwide-distribution percentiles to state-distribution percentiles is invisible to a reader (`P_PM25=78` looks the same) but means a different thing. Adopting the mirror without surfacing this distinction in the briefing UI would be a quiet semantics-drift.
3. **Demographic-index field redefined.** `P_D2_VULEOPCT` → `P_DEMOGIDX_2` is more than a rename: EJScreen 2023 dropped "vulnerable" from the demographic-index formula. Historical comparisons across a 2022 → 2023 cutover would be apples-to-oranges.

None of these prevent the mirror from being a usable data source. But each is a decision the operator should make explicitly. A silent URL swap by this agent would commit those decisions on the operator's behalf, which is not appropriate for federal-tier sourcing.

Verdict: **MISS at the EPA layer. EPA pill stays red on Redd until EPA publishes a v2.** The CalEPA mirror is documented as an operator-opt-in fallback in the adapter docstring + here.

## If the operator wants to opt into the CalEPA mirror

This would be a follow-up scope, not part of this dispatch. The work would be:

1. Replace the broker-URL constants in `epa-ejscreen.ts` with the ArcGIS Feature Server URL above.
2. Rewrite `run()` to build an ArcGIS REST point-intersects query (similar to existing arcgis.ts helpers) rather than the broker's GET-with-geometry shape.
3. Rename consumer-facing fields on `payload`: `population` ← `ACSTOTPOP`, `demographicIndexPercentile` ← `P_DEMOGIDX_2` (or `_5` for supplemental).
4. Update briefing UI copy to disclose state-percentile semantics + the CalEPA hosting attribution (federal tier with a state-source asterisk).
5. Decide refresh strategy: the mirror has not been updated since 2024-01-29. If/when CalEPA stops refreshing, this adapter's freshness threshold (currently 18 months — set assuming an EPA annual refresh cycle) will silently start tagging every read as stale.

Estimate: ~2-4 hours, contingent on operator approval of the three policy deltas above.

## Bounded-overlap check

This dispatch touched only `lib/adapters/src/federal/epa-ejscreen.ts` (docstring) and `_research/` (this note). Disjoint from:
- cc-agent-C2's Phase 2D.x scope: `lib/adapters/src/national/*` + `lib/site-context/server/*`
- cc-agent-R's 40e rendering parity scope: `artifacts/design-tools/.../renders/*` + `lib/renders/*`

No collision risk.

## Cleanup checklist

- [x] Docstring updated with dead-end record + sweep summary + fallback note
- [x] Session note durable copy at `_research/2026-05-23_qa22_epa_path1a_cc-agent-C.md`
- [ ] HR-11 inbox drop at `doc_repo/_inbox/2026-05-23_qa22_epa_path1a_cc-agent-C.md` (file only, no commit on doc_repo)
- [ ] Branch pushed to origin (operator may merge directly or open a PR; per dispatch, this agent does not open one)
