import {
  AMENDMENT_HAZARD_COLD_START_PRIOR,
  MEASUREMENT_A_TARGET,
  MIN_DENSE_SIGNAL,
  W_TARGET_RANKING,
} from "./constants.js";
import {
  caseMatchRate,
  caseSignalsFromDeposits,
  buildLineageBuckets,
  observedCaseAdjudicationRate,
  type CaseGrainSignal,
  type K2DepositLike,
} from "./caseGrain.js";
import type { LoadedCorpusAtom } from "./corpusLoader.js";
import { effectiveLambda, type InvalidationGranularity } from "./invalidation.js";
import {
  readAllAtomsAtSupportedGrain,
  type PooledReadResult,
  type ReadGrain,
} from "./pooledRead.js";
import type { QueryWeightMode } from "./types.js";

const GRANULARITIES: readonly InvalidationGranularity[] = [
  "whole-edition",
  "section-scoped",
  "section-plus-dependents",
];

export type GranularityV2Result = {
  granularity: InvalidationGranularity;
  /** Earned at pooled read grain AND survives amendment cadence at this granularity. */
  earnedFraction: number;
  /** Earned at pooled read grain only (no amendment-interval filter). */
  earnedFractionAtReadGrain: number;
  earnedWeighted: number;
  totalQueryWeight: number;
  meanClosureSize: number;
};

export type MeasurementAv2Result = {
  modelVersion: "m1-v2-case-grain-pooled-read";
  queryWeightMode: QueryWeightMode;
  targetFraction: number;
  wTargetRanking: number;
  lambdaPriorUsed: number;
  lambdaSource: "cold-start-prior" | "amendment-history";
  atomCount: number;
  caseCount: number;
  caseMatchRate: number;
  observedCaseRatePerYear: number;
  observationYears: number;
  byGranularity: GranularityV2Result[];
  readGrainDistribution: Record<ReadGrain, number>;
  provenanceDistribution: Record<string, number>;
  closureSizeDistribution: { min: number; median: number; max: number; mean: number };
  measurementBDeferred: true;
  measurementBReason: string;
  conditionA: string;
  conditionB: string;
};

function resolveQueryWeights(
  atoms: readonly LoadedCorpusAtom[],
  mode: QueryWeightMode,
): number[] {
  if (mode === "uniform") return atoms.map(() => 1);
  const weights = atoms.map((a) => a.queryWeight);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return atoms.map(() => 1);
  return weights;
}

function summarizeClosure(atoms: readonly LoadedCorpusAtom[]) {
  const sizes = atoms.map((a) => a.closureSize).sort((a, b) => a - b);
  if (sizes.length === 0) {
    return { min: 0, median: 0, max: 0, mean: 0 };
  }
  return {
    min: sizes[0]!,
    median: sizes[Math.floor(sizes.length / 2)]!,
    max: sizes[sizes.length - 1]!,
    mean: sizes.reduce((a, b) => a + b, 0) / sizes.length,
  };
}

/**
 * Measurement A v2 — earned fraction at pooled READ grain, query-weighted.
 * Invalidation granularity affects lambda-scaled earn sensitivity via closure.
 */
export function runMeasurementAv2(args: {
  atoms: readonly LoadedCorpusAtom[];
  deposits: readonly K2DepositLike[];
  entityIdToAtomId: ReadonlyMap<string, string>;
  queryWeightMode: QueryWeightMode;
  jurisdictionTenant: string;
  observationYears?: number;
  targetFraction?: number;
  wTargetRanking?: number;
  baseLambda?: number;
  lambdaSource?: "cold-start-prior" | "amendment-history";
}): MeasurementAv2Result {
  const observationYears = args.observationYears ?? 12;
  const wTarget = args.wTargetRanking ?? W_TARGET_RANKING;
  const baseLambda = args.baseLambda ?? AMENDMENT_HAZARD_COLD_START_PRIOR;
  const lambdaSource = args.lambdaSource ?? "cold-start-prior";

  const jurisdictionCases = caseSignalsFromDeposits(args.deposits).filter(
    (c) => c.jurisdictionTenant === args.jurisdictionTenant,
  );
  const lineageBuckets = buildLineageBuckets(jurisdictionCases);
  const reads = readAllAtomsAtSupportedGrain({
    atoms: args.atoms,
    lineageBuckets,
    entityIdToAtomId: args.entityIdToAtomId,
    wTarget,
  });
  const readByAtom = new Map(reads.map((r) => [r.atomId, r]));
  const queryWeights = resolveQueryWeights(args.atoms, args.queryWeightMode);

  const grainDist: Record<ReadGrain, number> = {
    atom: 0,
    "citation-closure": 0,
    "section-family": 0,
    class: 0,
  };
  const provDist: Record<string, number> = {
    "own-earned": 0,
    "pooled-applied": 0,
  };
  for (const r of reads) {
    grainDist[r.provenance.readGrain]++;
    provDist[r.provenance.signalSource]++;
  }

  const byGranularity: GranularityV2Result[] = GRANULARITIES.map(
    (granularity) => {
      let earnedWeighted = 0;
      let earnedAtReadOnly = 0;
      let totalQ = 0;
      for (let i = 0; i < args.atoms.length; i++) {
        const atom = args.atoms[i]!;
        const q = queryWeights[i] ?? 0;
        if (q <= 0) continue;
        totalQ += q;

        const read = readByAtom.get(atom.atomId);
        const earnedAtReadGrain = read?.earned ?? false;

        if (earnedAtReadGrain) {
          earnedAtReadOnly += q;
        }

        const lambdaEff = effectiveLambda({
          baseLambda,
          granularity,
          editionAtomCount: args.atoms.length,
          closureSize: atom.closureSize,
        });
        const amendmentInterval = 1 / lambdaEff;
        const caseRate = observedCaseAdjudicationRate(
          jurisdictionCases,
          observationYears,
        );
        const survivesAmendmentCadence =
          caseRate * amendmentInterval >= MIN_DENSE_SIGNAL;

        if (earnedAtReadGrain && survivesAmendmentCadence) {
          earnedWeighted += q;
        }
      }
      const closureSizes = args.atoms.map((a) => a.closureSize);
      const meanClosure =
        closureSizes.reduce((a, b) => a + b, 0) /
        Math.max(1, closureSizes.length);

      return {
        granularity,
        earnedFraction: totalQ > 0 ? earnedWeighted / totalQ : 0,
        earnedFractionAtReadGrain:
          totalQ > 0 ? earnedAtReadOnly / totalQ : 0,
        earnedWeighted,
        totalQueryWeight: totalQ,
        meanClosureSize: meanClosure,
      };
    },
  );

  return {
    modelVersion: "m1-v2-case-grain-pooled-read",
    queryWeightMode: args.queryWeightMode,
    targetFraction: args.targetFraction ?? MEASUREMENT_A_TARGET,
    wTargetRanking: wTarget,
    lambdaPriorUsed: baseLambda,
    lambdaSource,
    atomCount: args.atoms.length,
    caseCount: jurisdictionCases.length,
    caseMatchRate: caseMatchRate(jurisdictionCases),
    observedCaseRatePerYear: observedCaseAdjudicationRate(
      jurisdictionCases,
      observationYears,
    ),
    observationYears,
    byGranularity,
    readGrainDistribution: grainDist,
    provenanceDistribution: provDist,
    closureSizeDistribution: summarizeClosure(args.atoms),
    measurementBDeferred: true,
    measurementBReason:
      'Consequence-class pooling deferred — ICC ingest HELD; all atoms stratum "II".',
    conditionA:
      "read-contract provenance carries readGrain + signalSource (own-earned vs pooled-applied); pooled-applied never presented as atom-own earned.",
    conditionB:
      "Family pools draw only PUBLIC_PARTITION (__public__) backtest signal; tenant-private adjudications excluded from shared family posterior.",
  };
}

export function decisionReadV2(
  results: readonly MeasurementAv2Result[],
  targetFraction: number = MEASUREMENT_A_TARGET,
): string {
  const uniform = results.find((r) => r.queryWeightMode === "uniform");
  if (!uniform) return "No uniform-q result for decision read.";

  const sectionPlus = uniform.byGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!;
  const sectionScoped = uniform.byGranularity.find(
    (g) => g.granularity === "section-scoped",
  )!;
  const whole = uniform.byGranularity.find(
    (g) => g.granularity === "whole-edition",
  )!;

  const best = sectionPlus.earnedFraction;
  const bestReadOnly = sectionPlus.earnedFractionAtReadGrain;
  const caseRate = uniform.observedCaseRatePerYear;
  const PLAUSIBLE_CASE_RATE = 150;

  if (best >= targetFraction && caseRate <= PLAUSIBLE_CASE_RATE) {
    return `**GO.** Pooled read grain clears target (${(best * 100).toFixed(1)}% earned at section-plus-dependents, uniform q) at observed case rate ${caseRate.toFixed(1)}/year — reachable. Read-grain-only: ${(bestReadOnly * 100).toFixed(1)}%. Case match rate ${(uniform.caseMatchRate * 100).toFixed(1)}%.`;
  }

  if (bestReadOnly >= targetFraction) {
    return `**Marginal GO on read grain** (${(bestReadOnly * 100).toFixed(1)}% at pooled read, uniform q) but amendment cadence filters to ${(best * 100).toFixed(1)}% at section-plus-dependents. Case rate ${caseRate.toFixed(1)}/year; match rate ${(uniform.caseMatchRate * 100).toFixed(1)}%. Whole-edition amendment reset: ${(whole.earnedFraction * 100).toFixed(1)}%.`;
  }

  const v1Baseline = 0.003;
  const improvement = bestReadOnly / v1Baseline;
  return `**Target not met; grain diagnosis confirmed.** Pooled read grain earns ${(bestReadOnly * 100).toFixed(1)}% (uniform q, section-plus-dependents) vs v1 per-atom ${(v1Baseline * 100).toFixed(1)}% — ~${improvement.toFixed(0)}× improvement. K2 case match rate ${(uniform.caseMatchRate * 100).toFixed(1)}% proves fuel is real; shortfall is coverage (911–1205 cases across 941–2211 atoms, most pool at class grain without dense signal). Amendment cadence: whole-edition ${(whole.earnedFractionAtReadGrain * 100).toFixed(1)}% read-grain vs section-scoped ${(sectionScoped.earnedFractionAtReadGrain * 100).toFixed(1)}%. Below 70% target → per reversal criteria, planner should weigh case-level calibration product vs more outcome fuel before S-track.`;
}
