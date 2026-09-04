/**
 * RAIL SCORE ENGINE — one place where a measurement becomes a ledger row.
 *
 * Every per-rail scorer that has ever existed in this repo re-implemented the
 * same five decisions, and they do not agree with each other. Verified
 * 2026-08-19:
 *
 *   - `score_cad_rails_fast.mjs` clamps with `Math.min(100, (n/feat)*100)`
 *     and labels every below-threshold cell `needs-crosswalk`.
 *   - `countyGeometryScoreCli.ts` names that clamp as defect SF-25 and fails
 *     overcount CLOSED to `not-yet` with the honest unclamped ratio.
 *
 * One rule, two implementations, disagreeing — the CTRL-1 shape (DEV_PROCESS
 * 2.4). 762 live owner/landuse/cad rows carry the clamped value and a
 * classification that means "the join key is too thin to prove", which is not
 * what a below-threshold atom count means.
 *
 * So the decisions live HERE, once, and a rail declaration cannot reintroduce
 * any of them:
 *
 *   1. NO CLAMPING. `numerator > denominator` is a real signal (duplicate or
 *      stale atoms) and fails closed to `not-yet` carrying the honest,
 *      unclamped ratio. A clamp turns that signal into a satisfied cell.
 *   2. FACET == RAIL KEY, by construction, taken from the rule. The orphaned
 *      `land-use` rows exist because a facet string was typed by hand.
 *   3. THRESHOLD from `COUNTY_RAIL_DECLARATION`, never a per-scorer literal.
 *   4. ABSENCE IS A POSITIVE FINDING. `satisfied-absent` requires a probe
 *      that established it, a basis string, and the probe's reach covering
 *      the county. An empty result is not an absence (DEV_PROCESS 4.3), and a
 *      source that cannot see a county cannot report that county empty.
 *   5. AN UNSPECIFIED RAIL IS REFUSED, never scored as zero.
 *
 * CLASSIFIER. `classifyFacet` is imported from the pure leaf module
 * `lib/countyCoverageClassification.ts` rather than duplicated — it is the
 * single definition and the geometry and flood CLIs import the same one, so
 * copying it would create the future contradiction DEV_PROCESS 6.2 warns
 * about. `engine.test.ts` PINS the classifier behaviours this engine depends
 * on, so a change to them fails loudly instead of this engine drifting.
 *
 * IT USED TO BE IMPORTED FROM `countyCoverageScoreCli.ts`, AND THAT BROKE
 * PRODUCTION. `routes/countyRailScore.ts` imports this engine through the
 * `./index.ts` barrel, so the CLI was in the server's boot graph. esbuild
 * bundles everything into one file, which defeats the CLI's `isDirectRun()`
 * guard (`import.meta.url` and `argv[1]` are both the bundle), so the CLI's
 * `main()` ran at boot and `process.exit(1)`'d before Express listened — the
 * canary deploy of `5688aa31` on 2026-08-19. Never import a `*Cli` module
 * from anything on this path; `scripts/checkBootGraphNoCliImports.mjs`
 * enforces it.
 */

import {
  classifyFacet,
  type Classification,
} from "../countyCoverageClassification";
import {
  absenceProbeCoversCounty,
  isScoreableRule,
  type RailScoringRule,
} from "./registry";
import { formatRailScoreProvenance } from "./provenance";

export type RailState = "satisfied-present" | "satisfied-absent" | "not-yet";

/**
 * A positive absence determination. Either produced by a declared absence
 * probe, or supplied explicitly by an operator with evidence (the L7
 * honest-absence path the geometry CLI exposes as `--honest-absent`).
 */
export interface AbsenceDetermination {
  /** The citation. Required — a finding without its basis is unfalsifiable. */
  basis: string;
  /** Pointer to the evidence (decision doc, probe output, source response). */
  evidence?: string | null;
  /** Provenance label written to `source`. */
  source?: string | null;
}

/** What a measurement kind hands the engine. Deliberately free of any DB type. */
export interface RailCellMeasurement {
  countyFips: string;
  /** Measured numerator, or null when nothing could be measured. */
  numerator: number | null;
  /** Measured denominator, or null when the county has no denominator at all. */
  denominator: number | null;
  /** Whether the SOURCE exists for this county (not whether coverage is positive). */
  sourcePresent: boolean;
  /** Provenance label written to `source`, e.g. `parcel-node-atom-count`. */
  source: string | null;
  sourceVintage?: string | null;
  /** Free text for the provenance string's `detail` field. Must not contain ';'. */
  detail?: string | null;
  /** Set only when a declared probe POSITIVELY established absence. */
  absence?: AbsenceDetermination | null;
  /**
   * County-level absence already read from the atoms store (e.g. mud
   * `{fips}:_county_coverage` marker). Does not require an absence probe.
   */
  establishedAbsence?: AbsenceDetermination | null;
  /**
   * Layer applicability from serve-layer verdict vocabulary. When
   * `not-applicable`, the rail must not score as a coverage gap.
   */
  applicabilityVerdict?: "not-applicable" | null;
}

/** Exactly the values that define a ledger row. Timestamps are NOT here — see `railCellChanged`. */
export interface RailLedgerValues {
  countyFips: string;
  facet: string;
  honestCoveragePct: number;
  integrityVerdict: string;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  sampled: number;
  classification: Classification;
  railState: RailState;
  thresholdPct: number;
  absenceBasis: string | null;
  verificationMethod: string;
  verifiedByInstrument: string;
  artifactPath: string;
}

export interface RailCellScore extends RailLedgerValues {
  /** numerator > denominator: duplicate or stale atoms. Never clamped away. */
  overcount: boolean;
  /** Set when an absence was OFFERED but refused, with the reason. */
  absenceRefusedReason: string | null;
}

/**
 * Decide whether an offered absence may be written.
 *
 * PURE and separately exported because this is the control that stops the
 * Harris-only-source class of defect, and a control is only trusted once it
 * has been shown able to FIRE (DEV_PROCESS 2.2). `engine.test.ts` exercises
 * every refusal branch.
 */
export function resolveAbsence(
  rule: RailScoringRule,
  countyFips: string,
  offered: AbsenceDetermination | null | undefined,
): { allowed: true; determination: AbsenceDetermination } | { allowed: false; reason: string | null } {
  if (offered == null) return { allowed: false, reason: null };
  if (!offered.basis || offered.basis.trim() === "") {
    return {
      allowed: false,
      reason: "absence offered with no basis; an absence without its citation is unfalsifiable",
    };
  }
  const probe = rule.absenceProbe;
  if (!probe) {
    return {
      allowed: false,
      reason: `rail '${rule.railKey}' declares no absence probe, so it may not establish an absence`,
    };
  }
  if (!absenceProbeCoversCounty(probe, countyFips)) {
    return {
      allowed: false,
      reason:
        `absence refused for ${countyFips}: the '${probe.table}' source's reach is ` +
        `'${probe.reach.kind}' and does not cover this county. A source that cannot ` +
        `see a county cannot report that county empty.`,
    };
  }
  return { allowed: true, determination: { ...offered, basis: offered.basis.trim() } };
}

/**
 * Turn one measurement into one ledger row. PURE — no I/O, no clock.
 *
 * Throws for an `unspecified` rail. That is deliberate: the alternative is a
 * row reading 0% coverage, which is a claim about the world rather than a
 * statement that no rule exists.
 */
export function scoreRailCell(
  rule: RailScoringRule,
  thresholdPct: number,
  measurement: RailCellMeasurement,
): RailCellScore {
  if (!isScoreableRule(rule)) {
    if (rule.denominator.kind === "retired-unknown-denominator") {
      throw new Error(
        `rail '${rule.railKey}' has a retired denominator and cannot be scored ` +
          `until a new scorer lands. Substituting a reconstructible denominator ` +
          `would rewrite live rows against a different counting rule.`,
      );
    }
    if (rule.kind === "unspecified") {
      throw new Error(
        `rail '${rule.railKey}' has no measurement spec (kind 'unspecified'); ` +
          `it cannot be scored. Owner: ${rule.specOwner}.`,
      );
    }
    throw new Error(
      `rail '${rule.railKey}' cannot be scored (kind '${rule.kind}', ` +
        `denominator '${rule.denominator.kind}')`,
    );
  }

  const { countyFips, numerator, denominator } = measurement;
  const absence = resolveAbsence(rule, countyFips, measurement.absence);

  const provenanceFor = (num: number | null, den: number | null): string =>
    formatRailScoreProvenance({
      rail: rule.railKey,
      kind: rule.kind,
      numerator: num,
      denominator: den,
      denominatorKind: rule.denominator.kind,
      detail: measurement.detail ?? null,
    });

  const base = {
    countyFips,
    facet: rule.railKey,
    integrityVerdict: "n/a" as const,
    ownerMatchRate: null,
    sampled: 0,
    sourceVintage: measurement.sourceVintage ?? null,
    thresholdPct,
    verificationMethod: rule.verificationMethod,
    verifiedByInstrument: rule.instrument,
  };

  // --- county-level marker absence (mud L7 _county_coverage) -----------------
  const established = measurement.establishedAbsence;
  if (established?.basis?.trim()) {
    const facet = classifyFacet({
      facet: rule.railKey,
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: null,
      ownerMatchRate: null,
      source: established.source ?? "county-coverage-marker",
      sourceVintage: measurement.sourceVintage ?? null,
      sampled: 0,
    });
    return {
      ...base,
      honestCoveragePct: 0,
      classification: facet.classification,
      integrityVerdict: facet.integrityVerdict,
      source: facet.source,
      railState: "satisfied-absent",
      absenceBasis: established.basis.trim(),
      artifactPath: provenanceFor(numerator, denominator),
      overcount: false,
      absenceRefusedReason: null,
    };
  }

  // --- layer not applicable (verdict input, not a boolean gap) ---------------
  if (measurement.applicabilityVerdict === "not-applicable") {
    const facet = classifyFacet({
      facet: rule.railKey,
      rawCoveragePct: 0,
      sourcePresent: true,
      verdict: null,
      ownerMatchRate: null,
      source: "layer-not-applicable",
      sourceVintage: measurement.sourceVintage ?? null,
      sampled: 0,
    });
    return {
      ...base,
      honestCoveragePct: 0,
      classification: facet.classification,
      integrityVerdict: facet.integrityVerdict,
      source: facet.source,
      railState: "satisfied-absent",
      absenceBasis: "layer-not-applicable",
      artifactPath: provenanceFor(numerator, denominator),
      overcount: false,
      absenceRefusedReason: null,
    };
  }

  // --- established absence -------------------------------------------------
  if (absence.allowed) {
    const facet = classifyFacet({
      facet: rule.railKey,
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: null,
      ownerMatchRate: null,
      source: absence.determination.source ?? "honest-absence-determination",
      sourceVintage: measurement.sourceVintage ?? null,
      sampled: 0,
    });
    return {
      ...base,
      honestCoveragePct: 0,
      classification: facet.classification,
      integrityVerdict: facet.integrityVerdict,
      source: facet.source,
      railState: "satisfied-absent",
      absenceBasis: absence.determination.basis,
      artifactPath: provenanceFor(numerator, denominator),
      overcount: false,
      absenceRefusedReason: null,
    };
  }

  // --- no denominator ------------------------------------------------------
  // Fail closed to not-yet. Never invent an absence from a null denominator.
  if (denominator == null || denominator === 0) {
    const facet = classifyFacet({
      facet: rule.railKey,
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: null,
      ownerMatchRate: null,
      source: measurement.source,
      sourceVintage: measurement.sourceVintage ?? null,
      sampled: 0,
    });
    return {
      ...base,
      honestCoveragePct: 0,
      classification: facet.classification,
      integrityVerdict: facet.integrityVerdict,
      source: facet.source,
      railState: "not-yet",
      absenceBasis: null,
      artifactPath: provenanceFor(numerator, denominator),
      overcount: false,
      absenceRefusedReason: absence.reason,
    };
  }

  // --- measured ------------------------------------------------------------
  const num = numerator ?? 0;
  // UNCLAMPED, deliberately. See SF-25 in the file header.
  const rawCoveragePct = (num / denominator) * 100;
  const overcount = num > denominator;

  const facet = classifyFacet({
    facet: rule.railKey,
    rawCoveragePct,
    sourcePresent: measurement.sourcePresent,
    verdict: null,
    ownerMatchRate: null,
    source: measurement.source,
    sourceVintage: measurement.sourceVintage ?? null,
    sampled: 0,
  });

  const railState: RailState = overcount
    ? "not-yet"
    : facet.honestCoveragePct >= thresholdPct
      ? "satisfied-present"
      : "not-yet";

  return {
    ...base,
    honestCoveragePct: facet.honestCoveragePct,
    classification: facet.classification,
    integrityVerdict: facet.integrityVerdict,
    source: facet.source,
    railState,
    absenceBasis: null,
    artifactPath: provenanceFor(num, denominator),
    overcount,
    absenceRefusedReason: absence.reason,
  };
}

// ---------------------------------------------------------------------------
// Idempotency.
// ---------------------------------------------------------------------------

/**
 * Did this cell actually MOVE?
 *
 * "The upsert has ON CONFLICT" is not re-runnability. `checked_at` and
 * `last_verified_at` are bumped on every write, so an upsert always looks
 * like a change and a run report built from row counts would say every cell
 * moved every time. This compares the VALUES only, which is why neither
 * timestamp appears in `RailLedgerValues`.
 *
 * Same discipline as SS-W7's rule that a re-read must never masquerade as a
 * recompute: the thing that proves a job did something is the delta, not the
 * fact that it ran.
 */
/**
 * Did the COVERAGE FINDING move, as distinct from the row's paperwork?
 *
 * Needed because the first run under a new instrument rewrites `source`,
 * `verified_by_instrument` and `artifact_path` on every cell it touches, so
 * `railCellChanged` correctly reports ~100% changed exactly once — and a
 * reader glancing at that number would conclude the scorer had moved all of
 * Texas. It had not. This is the number that says whether what we CLAIM about
 * a county changed.
 */
export function railCellCoverageMoved(
  before: RailLedgerValues | null,
  after: RailLedgerValues,
): boolean {
  if (before === null) return true;
  return (
    before.honestCoveragePct.toFixed(2) !== after.honestCoveragePct.toFixed(2) ||
    before.railState !== after.railState
  );
}

export function railCellChanged(
  before: RailLedgerValues | null,
  after: RailLedgerValues,
): boolean {
  if (before === null) return true;
  return (
    before.countyFips !== after.countyFips ||
    before.facet !== after.facet ||
    // Compare coverage at the precision the column stores (numeric(5,2)).
    before.honestCoveragePct.toFixed(2) !== after.honestCoveragePct.toFixed(2) ||
    before.integrityVerdict !== after.integrityVerdict ||
    before.ownerMatchRate !== after.ownerMatchRate ||
    before.source !== after.source ||
    before.sourceVintage !== after.sourceVintage ||
    before.sampled !== after.sampled ||
    before.classification !== after.classification ||
    before.railState !== after.railState ||
    before.thresholdPct.toFixed(2) !== after.thresholdPct.toFixed(2) ||
    before.absenceBasis !== after.absenceBasis ||
    before.verificationMethod !== after.verificationMethod ||
    before.verifiedByInstrument !== after.verifiedByInstrument ||
    before.artifactPath !== after.artifactPath
  );
}
