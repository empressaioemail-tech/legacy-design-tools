/**
 * County Manifest rail dimension — CHECKED-IN DECLARATION, the single place
 * to update `atomFamilyState` / `hasWriter` / `atomFamilyRef` when the atom
 * contract or the engine's property-entity registration changes.
 *
 * BACKGROUND. `county_rail` (see `./countyRail.ts`) was seeded once by
 * migration 0068 (PR #391, 2026-08-08) and never refreshed. Three rails
 * (`geometry`, `footprint`, `easement`) drifted stale-optimistic-false: the
 * contract published `parcel-node`/`building-footprint`/`utility-easement`
 * in @empressaio/atom-contract 1.12.0-1.13.0 and hauska-engine PR #282
 * registered all three in `packages/atoms/src/property-instances.ts`'s
 * `PROPERTY_ENTITY_TYPES`, but the seeded rows still said
 * `missing`/`unpublished`. This module is the fix for the CLASS of defect,
 * not just the one-time patch: `countyRailRefreshCli.ts` reads THIS file
 * and issues idempotent UPDATEs, so the next drift is a one-line edit here
 * plus a CLI run, never a hand-written SQL patch again.
 *
 * WHY A DECLARATION AND NOT A LIVE CROSS-REPO DERIVATION. The obvious
 * "automatic" fix would have this file import `PROPERTY_ENTITY_TYPES`
 * directly from the published contract or from hauska-engine. Checked
 * 2026-08-08: this repo (`legacy-design-tools`) has NO live dependency edge
 * to that constant.
 *
 *   - `lib/engine-core/package.json` depends on `@hauska/atom-contract` via
 *     a VENDORED TARBALL pinned at 1.6.0 (`file:../../vendor/hauska-atom-
 *     contract-1.6.0.tgz`) — seven minor/major versions behind the current
 *     1.13.0, and under the OLD package name (`@hauska/*`, not
 *     `@empressaio/*`).
 *   - `PROPERTY_ENTITY_TYPES` is not even a contract-package export in the
 *     first place — it is an ENGINE-side registration list in
 *     `hauska-engine/packages/atoms/src/property-instances.ts`, a
 *     different repo this one does not import from at all, vendored or
 *     otherwise.
 *
 * Bridging that would mean adding a new cross-repo dependency (bumping the
 * vendored tarball, or a fresh npm dependency on the engine's atoms
 * package) as a side effect of a data-refresh task — out of scope here and
 * a bigger footprint than the defect warrants. The declaration below is
 * the honest alternative: one file, one obvious place to edit, checked
 * against the two upstream sources by hand at the version stamped below,
 * with a test (`countyRailDimension.test.ts`) that pins its shape so a
 * future edit that silently drops a rail or corrupts the ordinal sequence
 * fails CI. That test cannot detect upstream drift it has no dependency
 * edge to observe — it guards internal consistency of this file, not
 * freshness against the contract. Freshness is a human verification step,
 * recorded by the version stamp below; re-verify it whenever a contract or
 * engine PROPERTY_ENTITY_TYPES change lands.
 *
 * VERIFIED AGAINST (2026-08-08):
 *   - `npm view @empressaio/atom-contract version` => 1.13.0
 *   - `hauska-engine/packages/atoms/src/property-instances.ts`
 *     `PROPERTY_ENTITY_TYPES`: parcel-node, zoning-fact, setback-rule,
 *     buildable-envelope, parcel-terrain-model, building-footprint,
 *     utility-easement (7 entries, hauska-engine PR #282 merged).
 *   - `legacy-design-tools/artifacts/api-server/src/countyCoverageScoreCli.ts`
 *     is the live `land-use` facet writer, scored from `cad_property`
 *     (CAD roll `property_use_code`), independent of Cotality. The
 *     `land_use_code` field inside `hauska-engine/packages/adapters/src/
 *     national/cotality.ts` is DEAD — no scorer or bake path reads it —
 *     Cotality is extinguished per standing decision. `hasWriter=true` for
 *     `landuse` rests on the CAD scorer, not on Cotality; do not read the
 *     migration-0068 seed note ("only live carrier is Cotality") as
 *     describing the writer column — it described the ENGINE ATOM
 *     question (no land-use atom exists), a true but separate claim from
 *     "does a scorer/writer emit this facet" (yes, `countyCoverageScoreCli
 *     .ts`).
 *   - `join` (rail 3, "Join quality") removed from the dimension entirely
 *     per operator ruling 2026-08-08 (doc_repo `_decisions/2026-08-08_
 *     county_shape_thirteen_rails_and_geometry_first.md`, confirmed same
 *     day in a follow-up session): join quality is a DERIVED METRIC of fit
 *     between two acquired rails, not a rail with its own provenance/
 *     absence. Twelve rails, ordinals renumbered 1-12 with no gap.
 *
 * RAIL SPLIT 2026-08-09 (operator ruling R1, doc_repo `90_operations/
 * OPS-15_owner_and_rrc_rail_gap_analysis.md`). Twelve rails become
 * FOURTEEN: the single `rrc` rail splits into `rrc-wells` (point) and
 * `rrc-pipelines` (line), and `rail-corridor` is added.
 *
 * THE SPLIT RULE, so the next person extends this list the same way:
 * SPLIT where the SOURCE and GEOMETRY differ; SUBCATEGORIZE (atom body
 * fields) where only the attribute differs. Wells are points from one
 * endpoint and pipelines are lines from another, so one coverage number
 * could never honestly describe both — which is exactly why the merged
 * cell could only ever render HALF. Producing-vs-plugged is an attribute,
 * so it stays inside the cell.
 *
 * THIS MOVES THE DENOMINATOR: 254 x 12 = 3,048 cells becomes 254 x 14 =
 * 3,556, so every completeness percentage quoted before this change is
 * against a smaller denominator (89 satisfied cells read 0.897% at 3,048
 * and ~0.78% at 3,556). Nothing got worse; the grid simply stopped
 * hiding two layers we always owed. Do not "fix" the drop by reverting
 * the split — a launch gate that closes because the gap was never named
 * is the failure this manifest exists to prevent.
 *
 * `atomFamilyState` / `hasWriter` remain DECLARED FACTS, not enforcement —
 * editing this file does not create an atom or wire a writer, per the
 * class doc in `./countyRail.ts`.
 */

export type AtomFamilyState = "present" | "missing" | "partial" | "unpublished";
export type RailKind = "spine" | "derived";
/** Per OPS-14: jurisdiction-depth rails gate display on per-county coverage; statewide-uniform rails do not. */
export type CoverageClass = "statewide-uniform" | "jurisdiction-depth";

export interface CountyRailDeclaration {
  railKey: string;
  displayName: string;
  ordinal: number;
  railLetter: string | null;
  kind: RailKind;
  thresholdPct: number;
  coverageClass: CoverageClass;
  atomFamilyState: AtomFamilyState;
  atomFamilyRef: string | null;
  hasWriter: boolean;
  writerRef: string | null;
  declaredSource: string;
  notes: string | null;
}

/**
 * The twelve ruled rails, ruled order (join quality removed — see file
 * header). This is the CURRENT declared state; `countyRailRefreshCli.ts`
 * diffs live `county_rail` rows against this list and UPDATEs on
 * mismatch, plus DELETEs any row whose `railKey` no longer appears here
 * (currently: `join`).
 */
export const COUNTY_RAIL_DECLARATION: ReadonlyArray<CountyRailDeclaration> = [
  {
    railKey: "geometry",
    displayName: "Parcel geometry",
    ordinal: 1,
    railLetter: "C",
    kind: "spine",
    coverageClass: "statewide-uniform",
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "parcel-node (contract 1.13.0)",
    hasWriter: true,
    writerRef: "countyGeometryScoreCli.ts facet geometry",
    declaredSource:
      "TxGIO StratMap bulk zip per FIPS; county ArcGIS override where fresher",
    notes:
      "Spine rail. parcel-node shipped in contract 1.13.0 and is registered in the engine (hauska-engine PR #282) -- corrected from 'missing' 2026-08-08. Writer flipped true 2026-08-09: countyGeometryScoreCli.ts scores parcel-node atom count (ATOMS store) against txgio_parcel DISTINCT feature_index (DEPLOYMENT store) per county and writes county_facet_coverage facet='geometry'. Threshold 95%; below-threshold counties write rail_state='not-yet' with their real honest_coverage_pct, never satisfied-present.",
  },
  {
    railKey: "cad",
    displayName: "CAD attributes",
    ordinal: 2,
    railLetter: "B",
    kind: "spine",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "cad-parcel-roll (contract 1.14.0)",
    hasWriter: true,
    writerRef: "hauska-engine write-cad-parcel-roll-county.mjs",
    declaredSource: "County CAD (BIS/PACS/Orion/HCAD), joined to Rail C geometry",
    notes:
      "hasWriter flipped true 2026-08-09 after hauska-engine PR #291 merged write-cad-parcel-roll-county.mjs. Writer not run by default — declaration only.",
  },
  {
    railKey: "zoning",
    displayName: "Zoning + setback",
    ordinal: 3,
    railLetter: "A",
    kind: "spine",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "zoning-fact, setback-rule (contract)",
    hasWriter: true,
    writerRef: "countyCoverageScoreCli.ts facet land-use/:538 no -- zoning:591",
    declaredSource: "Municipal code per incorporated city; unincorporated county is unzoned",
    notes: "Typed absence discriminant; satisfied-absent is first-class here.",
  },
  {
    railKey: "roads",
    displayName: "Roads / frontage",
    ordinal: 4,
    railLetter: null,
    kind: "spine",
    coverageClass: "statewide-uniform",
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "road-node (contract + engine)",
    hasWriter: false,
    writerRef: null,
    declaredSource: "OSM Overpass plus county roadway layers",
    notes: "Atom exists, no scorer emits it, and no roster block backs it.",
  },
  {
    railKey: "flood",
    displayName: "Flood / terrain",
    ordinal: 5,
    railLetter: "D",
    kind: "spine",
    coverageClass: "statewide-uniform",
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "flood-hazard-fact (contract 1.14.0)",
    hasWriter: true,
    writerRef: "hauska-engine write-flood-hazard-fact-county.mjs",
    declaredSource: "FEMA NFHL, USGS 3DEP, USDA SSURGO",
    notes:
      "hasWriter flipped true 2026-08-09 after hauska-engine PR #291 merged write-flood-hazard-fact-county.mjs. NFHL bulk table loaded; writer not run by default — declaration only.",
  },
  {
    railKey: "envelope",
    displayName: "Buildable envelope",
    ordinal: 6,
    railLetter: null,
    kind: "derived",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "buildable-envelope (contract)",
    hasWriter: true,
    writerRef: "countyCoverageScoreCli.ts:602",
    declaredSource: "Derived from parcel geometry + zoning/setback + roads",
    notes:
      "Absence rides off-contract engine fields (warmVerifyDecline*); will not survive export (contract audit S4).",
  },
  {
    railKey: "landuse",
    displayName: "Land use",
    ordinal: 7,
    railLetter: null,
    kind: "derived",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "land-use-fact (contract 1.14.0)",
    hasWriter: true,
    writerRef:
      "hauska-engine write-land-use-fact-county.mjs; countyCoverageScoreCli.ts facet land-use (CAD roll scorer, pre-atom)",
    declaredSource: "CAD roll code (cad_property.property_use_code)",
    notes:
      "land-use-fact atom shipped contract 1.14.0; hauska-engine PR #291 write-land-use-fact-county.mjs. countyCoverageScoreCli.ts CAD-roll scorer remains the live facet writer until atom writers are run.",
  },
  {
    railKey: "footprint",
    displayName: "Building footprints",
    ordinal: 8,
    railLetter: null,
    kind: "derived",
    coverageClass: "statewide-uniform",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "building-footprint (contract 1.12.0)",
    hasWriter: false,
    writerRef: null,
    declaredSource: "ML-derived default statewide (Microsoft/Overture/USA Structures)",
    notes:
      "Published in contract 1.12.0 and registered in the engine (hauska-engine PR #282) -- corrected from 'unpublished' 2026-08-08. No scorer/writer yet.",
  },
  {
    railKey: "easement",
    displayName: "Utility easements",
    ordinal: 9,
    railLetter: null,
    kind: "derived",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "utility-easement (contract 1.12.0)",
    hasWriter: false,
    writerRef: null,
    declaredSource: "County honest-absence default; CAD exception where published",
    notes:
      "Published in contract 1.12.0 and registered in the engine (hauska-engine PR #282) -- corrected from 'unpublished' 2026-08-08. Roster easement_tier 'cad-easement-rest' (McLennan) is not a contract enum member -- will hard-fail Zod parse (contract audit S5) once a writer exists.",
  },
  {
    railKey: "owner",
    displayName: "Owner facet",
    ordinal: 10,
    railLetter: null,
    kind: "derived",
    coverageClass: "jurisdiction-depth",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "owner-fact (contract 1.16.0)",
    hasWriter: true,
    writerRef:
      "hauska-engine packages/engine-core/scripts/write-owner-fact-county.mjs (PR #297)",
    declaredSource: "CAD owner_name + owner_mailing_address (cad_property)",
    notes:
      "OWN LANE BUILT 2026-08-09 (doc_repo OPS-15): contract type published 1.16.0 (PR #15), engine registration + writer seam (PR #296), county writer CLI (PR #297). Corrected from 'missing'/false -- the earlier note read 'ruled public-paid at the atom level; no owner atom exists to carry the policy', i.e. the POLICY was ruled and the CARRIER was never built, which is why this column read NO ATOM over a store already holding owner_name on 4,525,073 of 4,599,477 cad_property rows (98.4%, 15 counties). THE ONLY public-paid ENTRY IN THIS DECLARATION: the contract schema pins accessPolicy public-paid and rejects anything else, the writer fail-closes before any write, and verifyStoredOwnerFactAtom re-checks the STORED bytes -- three layers, so owner identity cannot land on the free tier. Exemption codes are reduced to four booleans inside the writer seam and never reach an atom (homestead/over-65 codes imply occupancy). Coverage stays 0 until the apply runs; the apply needs the atoms bulk-writer slot.",
  },
  {
    railKey: "rrc-wells",
    displayName: "RRC wells",
    ordinal: 11,
    railLetter: null,
    kind: "derived",
    coverageClass: "statewide-uniform",
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource:
      "RRC public GIS wells (TXRRC/Wells MapServer/0) — already wired in lib/adapters/src/federal/texas-rrc.ts",
    notes:
      "Split from the former single `rrc` rail 2026-08-09 (operator ruling R1, doc_repo OPS-15). atomFamilyState corrected 'partial' -> 'missing': the ADR-025 O&G types ARE published (@empressaio/atom-contract exports ./og) but the PROPERTY SPINE holds ZERO of them -- live `SELECT entity_type, count(*) FROM atoms` returns 15 types, none O&G. 'partial' was stale-optimistic against this store, the same drift class this file was written to prevent. The og-twin repo is a separate universe from the county manifest; do not read its progress as this rail's state. Point geometry (surface hole). The missing piece is the parcelNodeId EDGE -- a well atom with no parcel join cannot answer 'is there a well on this property'. Subcategorize WITHIN this rail via atom body fields (status producing/permitted/dry/plugged-abandoned; type oil/gas/injection/disposal; orphaned flag), never by adding more rails. W3 HELD per 2026-08-01 scale ruling.",
  },
  {
    railKey: "rrc-pipelines",
    displayName: "RRC pipelines",
    ordinal: 12,
    railLetter: null,
    kind: "derived",
    coverageClass: "statewide-uniform",
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource:
      "RRC public GIS pipelines (TXRRC/Pipelines MapServer/0) — separate endpoint from the wells layer",
    notes:
      "Split from the former single `rrc` rail 2026-08-09 (operator ruling R1). SEPARATE from rrc-wells because the source endpoint and the GEOMETRY differ (line, not point) -- one coverage number cannot honestly describe both, which is why the merged cell could only ever render HALF. R2 RESOLVED 2026-08-09 FROM LIVE CODE, not from a guess: `lib/adapters/src/federal/texas-rrc.ts` already fetches TWO DISTINCT ArcGIS endpoints (TEXAS_RRC_WELLS_LAYER and TEXAS_RRC_PIPELINES_LAYER) and `brokerageGisFederalLayers.ts` already tags every feature `rrcAsset: 'well' | 'pipeline'` -- the data ALREADY arrives split, so the rail split matches the source shape rather than imposing on it. Scope is RRC public GIS (a Harris County mirror carrying statewide coverage); PHMSA NPMS is NOT wired and is not needed for v1 -- it restricts precise alignment for security reasons, so prefer the RRC layer. Pipeline fields already pulled: P5_NUM, OPER_NM, SYS_NM, COM_CARRIE. Buyer question is easements/setbacks and proximity, which OVERLAPS the easement rail; reconcile at read time, do not duplicate the linework. Subcategorize via body fields (carrier gas/hazardous-liquid/gathering; status active/abandoned; diameter class).",
  },
  {
    railKey: "rail-corridor",
    displayName: "Rail corridors",
    ordinal: 13,
    railLetter: null,
    kind: "derived",
    coverageClass: "statewide-uniform",
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource: "TxDOT rail inventory / FRA / NTAD (national, statewide-uniform)",
    notes:
      "NEW rail 2026-08-09 (operator ruling R1). RAILROAD TRACKS, NOT THE RAILROAD COMMISSION -- the `rrc-*` rails above are the Texas Railroad COMMISSION (oil and gas regulator); this one is track infrastructure. The name collision is the entire reason this note exists: a future agent reading 'RRC' and 'rail' in adjacent rows will conflate them otherwise. Different domain, source, geometry, and buyer question (proximity, at-grade crossing exposure, ROW encumbrance, quiet-zone/horn-noise disclosure). Classifies as statewide-UNIFORM under the 2026-08-01 scale ruling (single national source, no per-jurisdiction assembly), so it rides the cheap parallel track -- the OZ pattern, not the zoning pattern. Subcategorize via body fields (status active/abandoned/rail-trail; class mainline/spur/yard; at-grade crossing points).",
  },
  {
    railKey: "mud",
    displayName: "Special districts",
    ordinal: 14,
    railLetter: null,
    kind: "derived",
    coverageClass: "statewide-uniform",
    thresholdPct: 90,
    atomFamilyState: "present",
    atomFamilyRef: "special-district-fact (contract 1.19.0)",
    hasWriter: true,
    writerRef: "hauska-engine write-special-district-fact-county.mjs",
    declaredSource:
      "TCEQ WaterDistricts (tx_special_district); Comptroller SPDPID optional tax-rate enrich",
    notes:
      "P1-4 2026-08-11: Corrected from missing/Comptroller-only. special-district-fact built on TCEQ polygon PIP (hauska-engine PR #301, 2775 polygons loaded). MUD/WCID/MMD/FWSD/SUD/etc. are districtType body fields per R1 subcategorize rule, not separate rails. Comptroller registry enriches tax rates where join succeeds; ESD/PID/non-water types have no TCEQ geometry (758 Comptroller entities) and remain phase-4 expansion within the same atom family.",
  },
];

/** Ruled rail count as of 2026-08-08 (join quality removed). Downstream denominators (rollup, summary.totalRails) must derive from this, never a separate literal. */
/** Lookup from railKey to coverageClass — used by countyLedger read path to gate depth-rail display on per-county coverage. */
export const COVERAGE_CLASS_BY_RAIL_KEY: Readonly<Record<string, CoverageClass>> =
  Object.fromEntries(
    COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r.coverageClass]),
  );

export const COUNTY_RAIL_COUNT = COUNTY_RAIL_DECLARATION.length;
