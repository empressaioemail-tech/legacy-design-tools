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
 * `atomFamilyState` / `hasWriter` remain DECLARED FACTS, not enforcement —
 * editing this file does not create an atom or wire a writer, per the
 * class doc in `./countyRail.ts`.
 */

export type AtomFamilyState = "present" | "missing" | "partial" | "unpublished";
export type RailKind = "spine" | "derived";

export interface CountyRailDeclaration {
  railKey: string;
  displayName: string;
  ordinal: number;
  railLetter: string | null;
  kind: RailKind;
  thresholdPct: number;
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
    thresholdPct: 95,
    atomFamilyState: "present",
    atomFamilyRef: "parcel-node (contract 1.13.0)",
    hasWriter: false,
    writerRef: null,
    declaredSource:
      "TxGIO StratMap bulk zip per FIPS; county ArcGIS override where fresher",
    notes:
      "Spine rail. parcel-node shipped in contract 1.13.0 and is registered in the engine (hauska-engine PR #282) -- corrected from 'missing' 2026-08-08. Writer still false: nothing writes this atom yet, only the txgio_parcel geometry-truth frame the atom will eventually wrap.",
  },
  {
    railKey: "cad",
    displayName: "CAD attributes",
    ordinal: 2,
    railLetter: "B",
    kind: "spine",
    thresholdPct: 95,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource: "County CAD (BIS/PACS/Orion/HCAD), joined to Rail C geometry",
    notes: null,
  },
  {
    railKey: "zoning",
    displayName: "Zoning + setback",
    ordinal: 3,
    railLetter: "A",
    kind: "spine",
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
    thresholdPct: 95,
    atomFamilyState: "partial",
    atomFamilyRef: "parcel-terrain-model (terrain only; no flood atom)",
    hasWriter: false,
    writerRef: null,
    declaredSource: "FEMA NFHL, USGS 3DEP, USDA SSURGO",
    notes: "Terrain covered; flood half has no atom.",
  },
  {
    railKey: "envelope",
    displayName: "Buildable envelope",
    ordinal: 6,
    railLetter: null,
    kind: "derived",
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
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: true,
    writerRef: "countyCoverageScoreCli.ts:~355-608 (measureCoverage/scoreCounty, facet land-use)",
    declaredSource: "CAD roll code (cad_property.property_use_code)",
    notes:
      "No land-use ATOM exists in the contract or engine (confirmed 2026-08-08) -- atomFamilyState correctly stays 'missing'. hasWriter stays true: the live writer is countyCoverageScoreCli.ts's CAD-roll join (prop_id, with an owner-gated situs-address fallback for blocked counties), NOT the dead Cotality land_use_code field. Cotality is EXTINGUISHED per standing decision; its land_use_code path in hauska-engine's cotality.ts is unreferenced by any live scorer and is not what backs this rail's writer bit. Do not re-flip hasWriter to false on a future Cotality sighting without first checking whether the CAD scorer is still what's running.",
  },
  {
    railKey: "footprint",
    displayName: "Building footprints",
    ordinal: 8,
    railLetter: null,
    kind: "derived",
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
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource: "CAD owner_name + mailing, authenticated paid facet",
    notes: "Ruled public-paid at the atom level; no owner atom exists to carry the policy.",
  },
  {
    railKey: "rrc",
    displayName: "RRC wells / pipelines",
    ordinal: 11,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    atomFamilyState: "partial",
    atomFamilyRef: "12 O&G types (wells only; no parcelNodeId edge; pipelines missing)",
    hasWriter: false,
    writerRef: null,
    declaredSource: "RRC public GIS (W-1, H-10, PDQ)",
    notes: "W3 HELD per 2026-08-01 scale ruling.",
  },
  {
    railKey: "mud",
    displayName: "MUD / special districts",
    ordinal: 12,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    atomFamilyState: "missing",
    atomFamilyRef: null,
    hasWriter: false,
    writerRef: null,
    declaredSource: "TX Comptroller special-district registry",
    notes: "W4 HELD per 2026-08-01 scale ruling.",
  },
];

/** Ruled rail count as of 2026-08-08 (join quality removed). Downstream denominators (rollup, summary.totalRails) must derive from this, never a separate literal. */
export const COUNTY_RAIL_COUNT = COUNTY_RAIL_DECLARATION.length;
