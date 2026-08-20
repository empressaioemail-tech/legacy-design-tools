/**
 * RAIL SCORING REGISTRY — how each rail is measured, as DATA.
 *
 * WHY THIS FILE EXISTS. The portfolio ships twelve county writers and three
 * scorer CLIs, and every other row in `county_facet_coverage` came from a
 * one-off script somebody wrote for one afternoon. Verified against the
 * deployment store 2026-08-19: of 1,739 live ledger rows, 1,561 (89.8%) were
 * written by an instrument that is not checked into any repo —
 * `score_cad_rails_fast.mjs`, `l16-score-mud.mjs`,
 * `B2_cp2_geometry_scorer_apply.mjs`, `roster-load`, or NULL. Two of those
 * three scripts are not on the machine at all. Scoring was never a standing
 * capability, so there was nothing to re-run, which is why no recompute route
 * existed until this week.
 *
 * The instinct that produced twelve writers and three CLIs was to BUILD where
 * a DECLARATION would do. The same instinct produced the `mud` rail, which
 * duplicates a subject already loaded as `tx_special_district`. So: a rail
 * becomes scoreable by declaring how it is measured. Adding a rail whose
 * MEASUREMENT KIND already exists is an edit to this file and nothing else.
 * Adding a rail that needs a NEW kind is one function in `./measure.ts`
 * against a narrow interface, plus an entry here. That split is stated
 * plainly rather than sold as "no code ever" — DEV_PROCESS 0 is explicit that
 * a control which depends on someone remembering is not a control, and the
 * same honesty applies to claiming more generality than a design has.
 *
 * WHAT IS DELIBERATELY NOT HERE. `thresholdPct` lives in
 * `COUNTY_RAIL_DECLARATION` (`@workspace/db/schema`) and is read from there by
 * `thresholdPctForRail`. One rule, one home. The existing scorers each carry
 * their own `const GEOMETRY_THRESHOLD_PCT = 95` / `FLOOD_THRESHOLD_PCT = 95`
 * literal, which is two implementations of one rule and therefore the CTRL-1
 * shape DEV_PROCESS 2.4 names; `registry.test.ts` fails if this file grows a
 * threshold field.
 *
 * ALL FOURTEEN RAILS APPEAR HERE, including the six that have no measurement
 * spec yet. "Unmentioned" is the failure state; "out of scope, and here is
 * why, and here is who owns it" is a valid and required classification
 * (DEV_PROCESS 3.3). A rail declared `unspecified` is refused by the engine —
 * it can never be silently scored as zero.
 */

import { COUNTY_RAIL_DECLARATION } from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Denominators and reach.
// ---------------------------------------------------------------------------

export type DenominatorKind =
  /** DISTINCT feature_index in txgio_parcel for the county — the real-world parcel count. */
  | "txgio-parcel-distinct-feature-index"
  /** No denominator: the rail could not be measured for this county. */
  | "none";

export interface DenominatorSpec {
  kind: DenominatorKind;
  /**
   * The counting rule in prose. This string travels into every run report
   * next to the number it governs, per DEV_PROCESS 1.2 (the counting rule
   * rides at the point of use, not in an appendix).
   */
  basis: string;
}

/**
 * How far an acquisition source actually reaches.
 *
 * TRACED TO AN INCIDENT. The RRC wells source is a Harris-County mirror:
 * 12,796 features whose extent is one county, with a Dallas bbox returning
 * zero. Applying it statewide would have written mass FALSE ABSENCES — "no
 * wells here" for counties the instrument was never able to see. An absence
 * is only established if the instrument could have observed a positive
 * (DEV_PROCESS 4.3: an empty result is not an absence). The engine refuses to
 * write `satisfied-absent` for a county outside the probe's reach, and refuses
 * outright when reach is `unknown`.
 *
 * The converse also holds and is not weakened here: once an absence IS
 * established for a county inside reach, it is a first-class satisfied cell
 * and carries no discount for the source's limited reach elsewhere.
 */
export type SourceReach =
  | { kind: "statewide" }
  | { kind: "enumerated-counties"; counties: readonly string[] }
  | { kind: "unknown" };

/**
 * A POSITIVE absence determination the scorer may make on its own.
 *
 * `source-table-zero-rows`: the county has zero rows in the named source
 * table, and that source's reach covers the county, so "there are none here"
 * is a finding rather than an empty result. This is the shape `l16-score-mud`
 * used for the 74 live `mud` rows carrying basis
 * `tceq-tx_special_district-statewide-zero-districts-for-fips` — a real and
 * correct pattern that existed only inside a script nobody can read.
 */
export interface AbsenceProbeSpec {
  kind: "source-table-zero-rows";
  /** Table in the DEPLOYMENT store whose emptiness for a county establishes absence. */
  table: string;
  /** Column in that table carrying the 5-digit county FIPS. */
  fipsColumn: string;
  /** The basis string written to `absence_basis`. Required: a finding needs its citation. */
  basis: string;
  /** Where this source can actually see. Absence is refused outside it. */
  reach: SourceReach;
}

// ---------------------------------------------------------------------------
// Measurement kinds.
// ---------------------------------------------------------------------------

export type RailMeasurementKind =
  | "atom-count-over-parcel-features"
  | "parcel-column-stamp-rate"
  | "parcel-column-conjunction-rate"
  | "unspecified";

interface RailScoringRuleBase {
  /**
   * The rail key. This is ALSO the `facet` value written to
   * `county_facet_coverage`, by construction — never a separately typed
   * string.
   *
   * TRACED TO AN INCIDENT. `countyCoverageScoreCli.ts` writes facet
   * `land-use`. No rail key `land-use` exists; the rail is `landuse`. The
   * manifest grid joins `c.facet = r.rail_key`, so those 19 live rows join to
   * nothing and have never rendered a cell. A checked-in scorer has been a
   * silent no-op on the grid, and nothing failed. `registry.test.ts` makes an
   * unknown or duplicated rail key a build failure.
   */
  railKey: string;
  /** Written to `verified_by_instrument` so a row can always name what produced it. */
  instrument: string;
  /** Written to `verification_method`. `sweep` means every county in the target set is measured. */
  verificationMethod: "sweep" | "sample" | "roster-load" | "unverified";
  /** REQUIRED. The denominator is part of the rule, not an implementation detail. */
  denominator: DenominatorSpec;
  /** Optional positive-absence probe. Absent means this rail can never write an absence. */
  absenceProbe?: AbsenceProbeSpec;
  /** Free-text note carried into the run report. */
  notes?: string;
}

export interface AtomCountRule extends RailScoringRuleBase {
  kind: "atom-count-over-parcel-features";
  /** `atoms.entity_type` in the ATOMS store, counted per county by entity_id prefix. */
  entityType: string;
}

export interface ParcelColumnStampRule extends RailScoringRuleBase {
  kind: "parcel-column-stamp-rate";
  /** Column on txgio_parcel whose non-null share is the coverage. */
  column: string;
}

export interface ParcelColumnConjunctionRule extends RailScoringRuleBase {
  kind: "parcel-column-conjunction-rate";
  /** Columns on txgio_parcel that must ALL be non-null for a parcel to count. */
  columns: readonly string[];
}

/**
 * A rail with no measurement spec. Declared, not omitted. The engine refuses
 * it, so it can never be scored as an accidental zero.
 */
export interface UnspecifiedRule extends RailScoringRuleBase {
  kind: "unspecified";
  /** Why there is no rule yet, in enough detail that a stranger can act on it. */
  unspecifiedReason: string;
  /** Who owes the measurement spec. "Unassigned" is a blocking state (DEV_PROCESS 3.6). */
  specOwner: string;
}

export type RailScoringRule =
  | AtomCountRule
  | ParcelColumnStampRule
  | ParcelColumnConjunctionRule
  | UnspecifiedRule;

// ---------------------------------------------------------------------------
// The declaration.
// ---------------------------------------------------------------------------

const PARCEL_FEATURE_DENOMINATOR: DenominatorSpec = {
  kind: "txgio-parcel-distinct-feature-index",
  basis:
    "count(DISTINCT feature_index) in txgio_parcel for the county (falling back to txgio_parcel_staging). The FEATURE is the real-world parcel; txgio_parcel carries multiple rows per feature, so the raw row count would understate coverage several-fold on some counties.",
};

export const RAIL_SCORING_DECLARATION: readonly RailScoringRule[] = [
  {
    railKey: "geometry",
    kind: "atom-count-over-parcel-features",
    entityType: "parcel-node",
    instrument: "countyRailScoreCli.ts:geometry",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "DENOMINATOR DIVERGENCE, UNRESOLVED AND DELIBERATELY NOT PAPERED OVER. The 253 live geometry rows were written by B2_cp2_geometry_scorer_apply.mjs against an 'accounted features' denominator (their artifact_path carries denom=accounted;rawFeatures=...;accountedFeatures=...;foldedExtraFeatures=...). That producer is NOT in this repo — only a verify script that regexes its output (_P1-2_cp2_verify.mjs). This rule therefore declares the denominator that IS reconstructible from checked-in source, and will NOT reproduce the live values for counties with foldedExtraFeatures > 0. Re-scoring geometry needs the accounted-features rule recovered or re-ruled first; that is a finding for the planner, not something to guess at here.",
  },
  {
    railKey: "cad",
    kind: "atom-count-over-parcel-features",
    entityType: "cad-parcel-roll",
    instrument: "countyRailScoreCli.ts:cad",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
  },
  {
    railKey: "zoning",
    kind: "parcel-column-stamp-rate",
    column: "zoning_district",
    instrument: "countyRailScoreCli.ts:zoning",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Stamp rate, not data presence: a low percentage is a wired-city gap, not missing zoning. 235 of the live zoning rows are roster-load doctrine rows (source zoning-regime-doctrine) which the rollup deliberately excludes; this rule measures the stamp and does not touch the doctrine rows' basis.",
  },
  {
    railKey: "roads",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:roads",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage. county_rail declares an atom family and a writer, but no instrument has ever emitted a roads coverage number. The measurement spec must settle at minimum: numerator (road-node atoms? OSM way count? county roadway layer features?), denominator (parcels with frontage? county road-mile ceiling?), and whether a county with no acquired roads layer is not-yet or an established absence.",
    specOwner: "SS-W14",
  },
  {
    railKey: "flood",
    kind: "atom-count-over-parcel-features",
    entityType: "flood-hazard-fact",
    instrument: "countyRailScoreCli.ts:flood",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Reproduces countyFloodScoreCli.ts, which wrote the 177 live flood rows and is the one rail whose live values came from a checked-in instrument on a reconstructible denominator.",
  },
  {
    railKey: "envelope",
    kind: "parcel-column-conjunction-rate",
    columns: ["zoning_district", "geometry"],
    instrument: "countyRailScoreCli.ts:envelope",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Derivability proxy: the deterministic Tier-1 envelope needs both a zoning district and geometry. This measures the PRECONDITION, not envelopes produced, and the run report says so.",
  },
  {
    railKey: "landuse",
    kind: "atom-count-over-parcel-features",
    entityType: "land-use-fact",
    instrument: "countyRailScoreCli.ts:landuse",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "The 254 live landuse rows are land-use-fact atom counts from score_cad_rails_fast.mjs, which is what this reproduces. SEPARATE from countyCoverageScoreCli.ts's owner-gated CAD-roll join, which now upserts diagnostic facet 'landuse-cad-join' (the historical 'land-use' key is RETIRED; 19 orphan rows remain until operator-authorised retirement SQL). Both are named here so a successor does not mistake one for the other.",
  },
  {
    railKey: "footprint",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:footprint",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage, and the WRITTEN-to-SCORED leg is the whole gap: county_rail declares writer write-building-footprint-county.mjs and footprints were landed in 174 counties, but no instrument ever scored them, so a ledger recompute moves zero cells no matter how fresh it is. Spec must settle the denominator: footprints are not per-parcel (a parcel may carry zero or many), so parcel-feature count is the wrong denominator and an unclamped ratio would exceed 100 routinely.",
    specOwner: "SS-W14",
  },
  {
    railKey: "easement",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:easement",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage. The declared source is a county honest-absence DEFAULT with a CAD exception where published, which means this rail is mostly an absence rail — so its spec is mostly an absence-probe spec, and it must name what positively establishes 'no recorded easement layer for this county' rather than defaulting absence from an empty query.",
    specOwner: "SS-W14",
  },
  {
    railKey: "owner",
    kind: "atom-count-over-parcel-features",
    entityType: "owner-fact",
    instrument: "countyRailScoreCli.ts:owner",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "owner-fact is the only public-paid atom family in the rail declaration. This rule COUNTS atoms; it never reads an owner name, and no owner value enters the ledger.",
  },
  {
    railKey: "rrc-wells",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:rrc-wells",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage, and the acquisition source is HARRIS-ONLY: 12,796 features whose extent is one county, with a Dallas bbox returning zero. A spec that scores this statewide writes mass false absences. When the spec lands it MUST carry an absenceProbe with reach 'enumerated-counties', not 'statewide' — the engine will refuse a statewide absence claim it cannot back.",
    specOwner: "SS-W14",
  },
  {
    railKey: "rrc-pipelines",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:rrc-pipelines",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage. Line geometry from a different endpoint than the wells layer, so it needs its own denominator; a per-parcel ratio is the wrong shape for a linear feature and the spec must say what it is instead.",
    specOwner: "SS-W14",
  },
  {
    railKey: "rail-corridor",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:rail-corridor",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "Zero rows in county_facet_coverage. Railroad TRACKS, not the Railroad Commission — the name collision with the rrc-* rails above is why this note exists. Single national source, so a statewide absence probe is plausible here where it is not for rrc-wells; the spec must establish that rather than assume it.",
    specOwner: "SS-W14",
  },
  {
    railKey: "mud",
    kind: "unspecified",
    instrument: "countyRailScoreCli.ts:mud",
    verificationMethod: "sweep",
    denominator: { kind: "none", basis: "no measurement spec yet" },
    unspecifiedReason:
      "254 live rows exist (134 satisfied-present, 75 satisfied-absent) and the rule that produced them exists NOWHERE in checked-in source: l16-score-mud.mjs is not in this repo and is not on the machine. What the stored rows reveal is only an outline — source 'special-district-fact-determination-over-txgio-feature-index' for present cells, and absence basis 'tceq-tx_special_district-statewide-zero-districts-for-fips' for absent ones. Reconstructing a rule from the shape of its own output would be a guess presented as a spec, which is exactly the failure this lane was dispatched against, so it is declared unspecified. This rail is the single clearest statement of why scoring had to become a capability.",
    specOwner: "SS-W14",
  },
] as const;

// ---------------------------------------------------------------------------
// Lookups.
// ---------------------------------------------------------------------------

const RULE_BY_RAIL_KEY: ReadonlyMap<string, RailScoringRule> = new Map(
  RAIL_SCORING_DECLARATION.map((r) => [r.railKey, r]),
);

const THRESHOLD_BY_RAIL_KEY: ReadonlyMap<string, number> = new Map(
  COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r.thresholdPct]),
);

export function railScoringRuleFor(railKey: string): RailScoringRule | undefined {
  return RULE_BY_RAIL_KEY.get(railKey);
}

/**
 * The satisfied-vs-partial threshold for a rail, from `COUNTY_RAIL_DECLARATION`
 * — the single home for thresholds. Throws on an unknown rail rather than
 * defaulting, because a silent default is how a rail gets scored against a
 * threshold nobody chose.
 */
export function thresholdPctForRail(railKey: string): number {
  const t = THRESHOLD_BY_RAIL_KEY.get(railKey);
  if (t === undefined) {
    throw new Error(
      `no threshold for rail '${railKey}': it is not in COUNTY_RAIL_DECLARATION`,
    );
  }
  return t;
}

export function isScoreableRule(
  rule: RailScoringRule,
): rule is Exclude<RailScoringRule, UnspecifiedRule> {
  return rule.kind !== "unspecified";
}

/** Rails this capability can measure today. */
export function scoreableRailKeys(): string[] {
  return RAIL_SCORING_DECLARATION.filter(isScoreableRule).map((r) => r.railKey);
}

/** Rails declared but not yet measurable, with the reason and the owner. */
export function unspecifiedRails(): Array<{
  railKey: string;
  unspecifiedReason: string;
  specOwner: string;
}> {
  return RAIL_SCORING_DECLARATION.filter(
    (r): r is UnspecifiedRule => r.kind === "unspecified",
  ).map(({ railKey, unspecifiedReason, specOwner }) => ({
    railKey,
    unspecifiedReason,
    specOwner,
  }));
}

/** True when this probe may establish an absence for this county. */
export function absenceProbeCoversCounty(
  probe: AbsenceProbeSpec,
  countyFips: string,
): boolean {
  switch (probe.reach.kind) {
    case "statewide":
      return true;
    case "enumerated-counties":
      return probe.reach.counties.includes(countyFips);
    case "unknown":
      return false;
  }
}
