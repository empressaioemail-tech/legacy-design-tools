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
  /**
   * No measurement spec yet. The rail has never been measured; there is no
   * counting rule to recover. This is the unspecified-never-measured state
   * (roads, footprint, easement, …). It is NOT the state for live ledger
   * rows whose denominator was lost — that is `retired-unknown-denominator`.
   */
  | "none"
  /**
   * Live ledger rows exist, but the denominator they were computed against
   * is not reconstructible from checked-in source. Distinct from `none`:
   * retired-rows-with-unknown-denominator is not unspecified-never-measured.
   * A new scorer (a different card) must land before this rail is scored.
   */
  | "retired-unknown-denominator";

/**
 * Can a measurer actually execute this denominator today?
 *
 * EXHAUSTIVE OVER THE UNION, DELIBERATELY. A hardcoded allowlist (the prior
 * shape here was a `Set` of "live" kinds) fails OPEN by omission: a new
 * `DenominatorKind` added anywhere else in this file compiles fine and
 * silently reads as "not live" here, which is exactly how a rail can vanish
 * from `scoreableRailKeys()` — and therefore from a default
 * `railScoring/run.ts` run — with no error and no test failure. The `never`
 * assignment in the default case makes that omission a TYPE ERROR instead:
 * adding a kind without deciding whether it is executable is not allowed to
 * compile. (SS-W15's zoning-denominator card uses the identical pattern for
 * `denominatorNeedsCityBoundary` — same failure class, same fix shape.)
 */
export function isLiveCountingDenominatorKind(kind: DenominatorKind): boolean {
  switch (kind) {
    case "txgio-parcel-distinct-feature-index":
      return true;
    case "none":
    case "retired-unknown-denominator":
      return false;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled denominator kind: ${String(exhaustive)}`);
    }
  }
}

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
  /**
   * How the numerator is counted. Default `atom-count` is raw atom rows (may
   * exceed parcel-feature denominator for multi-atom-per-parcel families).
   * `distinct-parcel-keys` counts DISTINCT parcel keys parsed from entity_id
   * (family suffix stripped), so coverage cannot exceed 100%.
   */
  numeratorMode?: "atom-count" | "distinct-parcel-keys";
  /**
   * Provenance label when coverage is present. Default `${entityType}-atom-count`.
   * Mud uses `special-district-fact-determination-over-txgio-feature-index`.
   */
  presentSourceLabel?: string;
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
    denominator: {
      kind: "retired-unknown-denominator",
      basis:
        "RETIRED / UNMEASURED. Live geometry ledger rows were computed against an 'accounted features' denominator by B2_cp2_geometry_scorer_apply.mjs, which is not in this repo. The reconstructible parcel-feature count is a different rule and is not claimed here. Re-scoring waits on a new scorer (S-21); until then this rail is unscored.",
    },
    notes:
      "DENOMINATOR DIVERGENCE, UNRESOLVED AND DELIBERATELY NOT PAPERED OVER. The 253 live geometry rows were written by B2_cp2_geometry_scorer_apply.mjs against an 'accounted features' denominator (their artifact_path carries denom=accounted;rawFeatures=...;accountedFeatures=...;foldedExtraFeatures=...). That producer is NOT in this repo — only a verify script that regexes its output (_P1-2_cp2_verify.mjs). This rule therefore declares the denominator that IS reconstructible from checked-in source, and will NOT reproduce the live values for counties with foldedExtraFeatures > 0. Re-scoring geometry needs the accounted-features rule recovered or re-ruled first; that is a finding for the planner, not something to guess at here. RETIRED 2026-08-20 (S-22): the machine-readable denominator is no longer PARCEL_FEATURE_DENOMINATOR. Live geometry rows are 254 over 254 distinct county FIPS, not 253 (253 was a different rail's figure; source _inbox/2026-08-20_db_probe_five_answers.md Q2). Until a new scorer lands (S-21), this rail is unscored rather than re-derived against a different denominator.",
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
    kind: "atom-count-over-parcel-features",
    entityType: "road-node",
    instrument: "countyRailScoreCli.ts:roads",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Numerator is road-node atom rows per county (entity_id FIPS prefix). Ratio may exceed 100% when multiple road segments attach to one parcel feature; overcount fails closed to not-yet per SF-25.",
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
      "The 254 live landuse rows are land-use-fact atom counts from score_cad_rails_fast.mjs, which is what this reproduces. SEPARATE from countyCoverageScoreCli.ts's owner-gated CAD-roll join, which writes facet 'land-use' (orphaned: no such rail key) and is owned by lane SS-W13. Both are named here so a successor does not mistake one for the other.",
  },
  {
    railKey: "footprint",
    kind: "atom-count-over-parcel-features",
    entityType: "building-footprint",
    numeratorMode: "distinct-parcel-keys",
    instrument: "countyRailScoreCli.ts:footprint",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Numerator is DISTINCT parcel keys with at least one building-footprint atom (entity_id prefix before the family suffix). Denominator is parcel-feature count. Raw atom count is the wrong numerator because a parcel may carry zero or many footprints.",
  },
  {
    railKey: "easement",
    kind: "atom-count-over-parcel-features",
    entityType: "utility-easement",
    instrument: "countyRailScoreCli.ts:easement",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Numerator is utility-easement atom rows. Honest-absence counties emit ONE county-coverage atom (not per-parcel), so present-data counties drive the ratio; absent counties stay not-yet until a positive county-coverage absence atom exists or an absence probe lands.",
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
    kind: "atom-count-over-parcel-features",
    entityType: "well-fact",
    instrument: "countyRailScoreCli.ts:rrc-wells",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    absenceProbe: {
      kind: "source-table-zero-rows",
      table: "rrc_wells",
      fipsColumn: "county_fips",
      basis: "texas-rrc-wells-v1-source-zero-rows-for-fips",
      reach: { kind: "enumerated-counties", counties: ["48201"] },
    },
    notes:
      "Acquisition source is Harris-only (12,796 features). Absence may be established ONLY inside reach; all other counties refuse absence and stay not-yet rather than false 0% gaps.",
  },
  {
    railKey: "rrc-pipelines",
    kind: "atom-count-over-parcel-features",
    entityType: "rrc-pipeline-fact",
    instrument: "countyRailScoreCli.ts:rrc-pipelines",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Statewide line geometry from Texas RRC public GIS. Per-parcel ratio is an approximation (linear features); overcount fails closed to not-yet.",
  },
  {
    railKey: "rail-corridor",
    kind: "atom-count-over-parcel-features",
    entityType: "rail-corridor-fact",
    instrument: "countyRailScoreCli.ts:rail-corridor",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    notes:
      "Railroad TRACKS (national source), not Railroad Commission. Per-parcel atom ratio is an approximation for linear adjacency; overcount fails closed to not-yet.",
  },
  {
    railKey: "mud",
    kind: "atom-count-over-parcel-features",
    entityType: "special-district-fact",
    numeratorMode: "distinct-parcel-keys",
    presentSourceLabel: "special-district-fact-determination-over-txgio-feature-index",
    instrument: "countyRailScoreCli.ts:mud",
    verificationMethod: "sweep",
    denominator: PARCEL_FEATURE_DENOMINATOR,
    absenceProbe: {
      kind: "source-table-zero-rows",
      table: "tx_special_district",
      fipsColumn: "county_fips",
      basis: "tceq-tx_special_district-statewide-zero-districts-for-fips",
      reach: { kind: "statewide" },
    },
    notes:
      "Numerator is DISTINCT parcel keys with at least one special-district-fact determination (entity_id FIPS prefix before the :sd: family suffix). The county marker {fips}:_county_coverage is excluded from the ratio and establishes satisfied-absent instead. tx_special_district zero rows for the FIPS establishes satisfied-absent; features=0 with districts>0 (Donley 48129) fails closed to not-yet.",
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

/**
 * Plain `boolean`, NOT a type predicate. It used to narrow to
 * `Exclude<RailScoringRule, UnspecifiedRule>`, which was accurate when
 * "not scoreable" meant exactly `kind === "unspecified"`. It no longer does:
 * a rule can keep a specified `kind` (geometry is still
 * `atom-count-over-parcel-features`) and still be unscoreable because its
 * denominator is retired. A stale predicate here does not just mislabel —
 * `scoreRailCell`'s `if (!isScoreableRule(rule))` branch would have TypeScript
 * narrow `rule` to `UnspecifiedRule`, prove its own `kind === "unspecified"`
 * check always true, and therefore prove its own trailing fallback `throw`
 * unreachable (`rule: never`) — a real compile error, not a rebase artifact.
 *
 * A measurement kind without an executable denominator is not scoreable.
 * Geometry keeps kind `atom-count-over-parcel-features` (the numerator shape
 * is still parcel-node atom count) but its denominator is retired, so
 * substituting the reconstructible parcel-feature count would rescore live
 * rows against a different rule. Unspecified rails use kind `none`.
 */
export function isScoreableRule(rule: RailScoringRule): boolean {
  return (
    rule.kind !== "unspecified" &&
    isLiveCountingDenominatorKind(rule.denominator.kind)
  );
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

/**
 * Rails whose live ledger rows were computed against a denominator that is
 * not reconstructible from checked-in source. Distinct from `unspecifiedRails`
 * (never measured) and from `scoreableRailKeys` (executable denominator).
 */
export function retiredDenominatorRails(): Array<{
  railKey: string;
  denominatorKind: DenominatorKind;
  basis: string;
}> {
  return RAIL_SCORING_DECLARATION.filter(
    (r) => r.denominator.kind === "retired-unknown-denominator",
  ).map((r) => ({
    railKey: r.railKey,
    denominatorKind: r.denominator.kind,
    basis: r.denominator.basis,
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
