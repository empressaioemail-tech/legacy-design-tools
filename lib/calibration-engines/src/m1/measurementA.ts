import {
  AMENDMENT_HAZARD_COLD_START_PRIOR,
  DEFAULT_CORPUS_BASELINE,
  MEASUREMENT_A_TARGET,
  S0_DEFAULT,
  SOURCE_QUALITY_BASELINE,
} from "./constants.js";
import { computeNStar, summarizeNStarDistribution } from "./betaPosterior.js";
import {
  effectiveLambda,
  type InvalidationGranularity,
} from "./invalidation.js";
import type {
  CodeSectionAtomInput,
  GranularityResult,
  MeasurementAMode,
  MeasurementAResult,
  QueryWeightMode,
} from "./types.js";

const GRANULARITIES: readonly InvalidationGranularity[] = [
  "whole-edition",
  "section-scoped",
  "section-plus-dependents",
];

export function assertedBaselineFromSourceType(sourceType: string | null): number {
  const key = (sourceType ?? "").trim().toLowerCase();
  return SOURCE_QUALITY_BASELINE[key] ?? DEFAULT_CORPUS_BASELINE;
}

function resolveQueryWeights(
  atoms: readonly CodeSectionAtomInput[],
  mode: QueryWeightMode,
): number[] {
  if (mode === "uniform") {
    return atoms.map(() => 1);
  }
  const weights = atoms.map((a) => a.queryWeight ?? 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    return atoms.map(() => 1);
  }
  return weights;
}

function perAtomThresholds(
  atoms: readonly CodeSectionAtomInput[],
  granularity: InvalidationGranularity,
  baseLambda: number,
  editionAtomCount: number,
): number[] {
  return atoms.map((atom) => {
    const nStar = computeNStar({ mu0: atom.mu0, s0: S0_DEFAULT });
    const lambdaEff = effectiveLambda({
      baseLambda,
      granularity,
      editionAtomCount,
      closureSize: atom.closureSize ?? 1,
    });
    return nStar * lambdaEff;
  });
}

/**
 * Solve for minimum uniform adjudication rate a such that
 * sum_i q_i · 1[a/λ_i >= n*_i] / sum_i q_i >= targetFraction.
 */
export function solveMinimumAdjudicationRate(args: {
  atoms: readonly CodeSectionAtomInput[];
  queryWeights: readonly number[];
  granularity: InvalidationGranularity;
  baseLambda: number;
  editionAtomCount: number;
  targetFraction?: number;
}): { requiredA: number; earnedAtRequired: number } {
  const target = args.targetFraction ?? MEASUREMENT_A_TARGET;
  const thresholds = perAtomThresholds(
    args.atoms,
    args.granularity,
    args.baseLambda,
    args.editionAtomCount,
  );
  const pairs = thresholds
    .map((t, i) => ({ threshold: t, q: args.queryWeights[i] ?? 0 }))
    .sort((a, b) => a.threshold - b.threshold);

  const totalQ = pairs.reduce((s, p) => s + p.q, 0);
  if (totalQ <= 0) {
    return { requiredA: Infinity, earnedAtRequired: 0 };
  }

  let cumQ = 0;
  for (const { threshold, q } of pairs) {
    cumQ += q;
    if (cumQ / totalQ >= target) {
      const earned = pairs.filter((p) => p.threshold <= threshold).length;
      return { requiredA: threshold, earnedAtRequired: earned / pairs.length };
    }
  }

  const last = pairs[pairs.length - 1]?.threshold ?? Infinity;
  return { requiredA: last, earnedAtRequired: 1 };
}

/**
 * Measurement A with observed per-atom adjudication rates (K2 fuel).
 */
export function measureAWithObservedRates(args: {
  atoms: readonly CodeSectionAtomInput[];
  queryWeights: readonly number[];
  granularity: InvalidationGranularity;
  baseLambda: number;
  editionAtomCount: number;
}): { fraction: number; earnedWeighted: number; totalWeight: number } {
  let earnedWeighted = 0;
  let totalWeight = 0;

  for (let i = 0; i < args.atoms.length; i++) {
    const atom = args.atoms[i]!;
    const q = args.queryWeights[i] ?? 0;
    if (q <= 0) continue;

    const nStar = computeNStar({ mu0: atom.mu0, s0: S0_DEFAULT });
    const lambdaEff = effectiveLambda({
      baseLambda: args.baseLambda,
      granularity: args.granularity,
      editionAtomCount: args.editionAtomCount,
      closureSize: atom.closureSize ?? 1,
    });
    const a = atom.adjudicationRate ?? 0;
    const earned = a / lambdaEff >= nStar ? 1 : 0;
    earnedWeighted += q * earned;
    totalWeight += q;
  }

  return {
    fraction: totalWeight > 0 ? earnedWeighted / totalWeight : 0,
    earnedWeighted,
    totalWeight,
  };
}

export function runMeasurementA(args: {
  atoms: readonly CodeSectionAtomInput[];
  queryWeightMode: QueryWeightMode;
  mode: MeasurementAMode;
  baseLambda?: number;
  amendmentAtomCount?: number;
  editionAtomCount: number;
  targetFraction?: number;
}): MeasurementAResult {
  const baseLambda = args.baseLambda ?? AMENDMENT_HAZARD_COLD_START_PRIOR;
  const amendmentAtomCount = args.amendmentAtomCount ?? 0;
  const queryWeights = resolveQueryWeights(args.atoms, args.queryWeightMode);
  const nStars = args.atoms.map((a) => computeNStar({ mu0: a.mu0, s0: S0_DEFAULT }));

  const byGranularity: GranularityResult[] = GRANULARITIES.map((granularity) => {
    if (args.mode === "solve-for") {
      const { requiredA } = solveMinimumAdjudicationRate({
        atoms: args.atoms,
        queryWeights,
        granularity,
        baseLambda,
        editionAtomCount: args.editionAtomCount,
        targetFraction: args.targetFraction,
      });
      return {
        granularity,
        requiredAdjudicationRate: requiredA,
        observedFraction: null,
        earnedAtomCount: 0,
        totalWeightedAtoms: args.atoms.length,
      };
    }

    const { fraction, earnedWeighted, totalWeight } = measureAWithObservedRates({
      atoms: args.atoms,
      queryWeights,
      granularity,
      baseLambda,
      editionAtomCount: args.editionAtomCount,
    });
    return {
      granularity,
      requiredAdjudicationRate: null,
      observedFraction: fraction,
      earnedAtomCount: Math.round(earnedWeighted),
      totalWeightedAtoms: Math.round(totalWeight),
    };
  });

  return {
    mode: args.mode,
    queryWeightMode: args.queryWeightMode,
    targetFraction: args.targetFraction ?? MEASUREMENT_A_TARGET,
    lambdaPriorUsed: baseLambda,
    lambdaSource:
      amendmentAtomCount > 0 ? "amendment-history" : "cold-start-prior",
    amendmentAtomCount,
    atomCount: args.atoms.length,
    nStarDistribution: summarizeNStarDistribution(nStars),
    byGranularity,
    measurementBDeferred: true,
    measurementBReason:
      'All atoms stratum "II" (routine) — ICC ingest HELD; no F2 consequence stratification.',
  };
}
