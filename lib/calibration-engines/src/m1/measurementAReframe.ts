/**
 * M1 reframe — three-metric pass (adjudication-weighted slice + coverage honesty + M-B slot).
 *
 * Spec: endstate_A_m1_amendment + 05_measurement_spec (query-weighted slice).
 */

import {
  AMENDMENT_HAZARD_COLD_START_PRIOR,
  MEASUREMENT_A_TARGET,
  MIN_DENSE_SIGNAL,
  PUBLIC_PARTITION,
  W_TARGET_ACTUATION,
  W_TARGET_RANKING,
} from "./constants.js";
import {
  caseMatchRate,
  caseSignalsFromDeposits,
  buildLineageBuckets,
  observedCaseAdjudicationRate,
  type K2DepositLike,
} from "./caseGrain.js";
import type { LoadedCorpusAtom } from "./corpusLoader.js";
import { effectiveLambda, type InvalidationGranularity } from "./invalidation.js";
import {
  readAllAtomsAtSupportedGrain,
  type PooledReadResult,
  type ReadGrain,
} from "./pooledRead.js";
import { runMeasurementAv2, type MeasurementAv2Result } from "./measurementAv2.js";

const GRANULARITIES: readonly InvalidationGranularity[] = [
  "whole-edition",
  "section-scoped",
  "section-plus-dependents",
];

export type SliceGranularityResult = {
  granularity: InvalidationGranularity;
  /** Adjudication-weighted earned fraction on cited atoms only. */
  sliceEarnedFraction: number;
  sliceEarnedFractionAtReadGrain: number;
  sliceEarnedWeight: number;
  sliceTotalWeight: number;
  adjudicatedAtomCount: number;
};

export type CoverageHonesty = {
  corpusAtomCount: number;
  adjudicatedAtomCount: number;
  unAdjudicatedAtomCount: number;
  unAdjudicatedShare: number;
  /** Atoms with ≥1 case citation (direct adjudication signal). */
  directlyCitedAtomCount: number;
  /** Earned-slice: cited atoms earning at pooled read grain. */
  earnedSliceAtomCount: number;
  /** Cited but not earned at read grain. */
  adjudicatedNotEarnedCount: number;
  /** Asserted-tail: zero adjudication — asserted prior only. */
  assertedTailAtomCount: number;
  /** Condition A — provenance class counts across full corpus reads. */
  provenanceByClass: {
    "earned-slice-own": number;
    "earned-slice-pooled": number;
    "adjudicated-not-earned": number;
    "asserted-tail": number;
  };
};

export type MeasurementBSlot = {
  status: "deferred";
  reason: string;
  wTargetActuation: number;
  stratum: "II-routine-only";
  highConsequenceAtomCount: number;
  highConsequenceEarnedFraction: number;
  iccFuelRequired: true;
};

export type ThreeMetricM1Result = {
  modelVersion: "m1-three-metric-reframe";
  jurisdictionTenant: string;
  targetFraction: number;
  observationYears: number;
  caseCount: number;
  caseMatchRate: number;
  /** (legacy) Uniform-corpus earned — full atom count, q=1 each. */
  corpusUniform: MeasurementAv2Result;
  /** (a) Adjudication-weighted slice per granularity. */
  sliceByGranularity: SliceGranularityResult[];
  /** (b) Un-adjudicated tail + provenance honesty. */
  coverage: CoverageHonesty;
  /** (c) Measurement B framework slot — parked on ICC. */
  measurementB: MeasurementBSlot;
  readGrainDistribution: Record<ReadGrain, number>;
};

/** Case-citation count per atom — pre-client stand-in for query frequency. */
export function buildAdjudicationWeights(
  atoms: readonly LoadedCorpusAtom[],
  lineageBuckets: ReadonlyMap<string, unknown[]>,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const atom of atoms) {
    const cited =
      lineageBuckets.get(`${PUBLIC_PARTITION}::${atom.atomId}`)?.length ?? 0;
    weights.set(atom.atomId, cited);
  }
  return weights;
}

function classifyReadProvenance(
  read: PooledReadResult,
  adjudicationWeight: number,
): keyof CoverageHonesty["provenanceByClass"] {
  if (adjudicationWeight <= 0) return "asserted-tail";
  if (read.earned) {
    return read.provenance.signalSource === "own-earned"
      ? "earned-slice-own"
      : "earned-slice-pooled";
  }
  return "adjudicated-not-earned";
}

export function runThreeMetricM1(args: {
  atoms: readonly LoadedCorpusAtom[];
  deposits: readonly K2DepositLike[];
  entityIdToAtomId: ReadonlyMap<string, string>;
  jurisdictionTenant: string;
  observationYears?: number;
  targetFraction?: number;
  wTargetRanking?: number;
  baseLambda?: number;
  lambdaSource?: "cold-start-prior" | "amendment-history";
}): ThreeMetricM1Result {
  const observationYears = args.observationYears ?? 12;
  const wTarget = args.wTargetRanking ?? W_TARGET_RANKING;
  const baseLambda = args.baseLambda ?? AMENDMENT_HAZARD_COLD_START_PRIOR;
  const targetFraction = args.targetFraction ?? MEASUREMENT_A_TARGET;

  const jurisdictionCases = caseSignalsFromDeposits(args.deposits).filter(
    (c) => c.jurisdictionTenant === args.jurisdictionTenant,
  );
  const lineageBuckets = buildLineageBuckets(jurisdictionCases);
  const adjudicationWeights = buildAdjudicationWeights(args.atoms, lineageBuckets);

  const reads = readAllAtomsAtSupportedGrain({
    atoms: args.atoms,
    lineageBuckets,
    entityIdToAtomId: args.entityIdToAtomId,
    wTarget,
  });
  const readByAtom = new Map(reads.map((r) => [r.atomId, r]));

  const corpusUniform = runMeasurementAv2({
    atoms: args.atoms,
    deposits: args.deposits,
    entityIdToAtomId: args.entityIdToAtomId,
    queryWeightMode: "uniform",
    jurisdictionTenant: args.jurisdictionTenant,
    observationYears,
    targetFraction,
    wTargetRanking: wTarget,
    baseLambda,
    lambdaSource: args.lambdaSource,
  });

  const provenanceByClass: CoverageHonesty["provenanceByClass"] = {
    "earned-slice-own": 0,
    "earned-slice-pooled": 0,
    "adjudicated-not-earned": 0,
    "asserted-tail": 0,
  };

  let adjudicatedAtomCount = 0;
  let earnedSliceAtomCount = 0;
  let adjudicatedNotEarnedCount = 0;

  for (const atom of args.atoms) {
    const w = adjudicationWeights.get(atom.atomId) ?? 0;
    const read = readByAtom.get(atom.atomId);
    if (!read) continue;

    const cls = classifyReadProvenance(read, w);
    provenanceByClass[cls]++;

    if (w > 0) {
      adjudicatedAtomCount++;
      if (read.earned) earnedSliceAtomCount++;
      else adjudicatedNotEarnedCount++;
    }
  }

  const unAdjudicatedAtomCount = args.atoms.length - adjudicatedAtomCount;

  const sliceByGranularity: SliceGranularityResult[] = GRANULARITIES.map(
    (granularity) => {
      let sliceEarnedWeight = 0;
      let sliceEarnedAtReadOnly = 0;
      let sliceTotalWeight = 0;

      for (const atom of args.atoms) {
        const adjW = adjudicationWeights.get(atom.atomId) ?? 0;
        if (adjW <= 0) continue;
        sliceTotalWeight += adjW;

        const read = readByAtom.get(atom.atomId);
        const earnedAtReadGrain = read?.earned ?? false;

        if (earnedAtReadGrain) {
          sliceEarnedAtReadOnly += adjW;
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
          sliceEarnedWeight += adjW;
        }
      }

      return {
        granularity,
        sliceEarnedFraction:
          sliceTotalWeight > 0 ? sliceEarnedWeight / sliceTotalWeight : 0,
        sliceEarnedFractionAtReadGrain:
          sliceTotalWeight > 0 ? sliceEarnedAtReadOnly / sliceTotalWeight : 0,
        sliceEarnedWeight,
        sliceTotalWeight,
        adjudicatedAtomCount,
      };
    },
  );

  const grainDist: Record<ReadGrain, number> = {
    atom: 0,
    "citation-closure": 0,
    "section-family": 0,
    class: 0,
  };
  for (const r of reads) {
    grainDist[r.provenance.readGrain]++;
  }

  return {
    modelVersion: "m1-three-metric-reframe",
    jurisdictionTenant: args.jurisdictionTenant,
    targetFraction,
    observationYears,
    caseCount: jurisdictionCases.length,
    caseMatchRate: caseMatchRate(jurisdictionCases),
    corpusUniform,
    sliceByGranularity,
    coverage: {
      corpusAtomCount: args.atoms.length,
      adjudicatedAtomCount,
      unAdjudicatedAtomCount,
      unAdjudicatedShare: unAdjudicatedAtomCount / Math.max(1, args.atoms.length),
      directlyCitedAtomCount: adjudicatedAtomCount,
      earnedSliceAtomCount,
      adjudicatedNotEarnedCount,
      assertedTailAtomCount: unAdjudicatedAtomCount,
      provenanceByClass,
    },
    measurementB: {
      status: "deferred",
      reason:
        'ICC ingest HELD — no I-Code consequence stratification; all atoms treated as stratum "II" (routine). High-consequence slice (W_actuation=0.2) cannot earn until ICC fuel lands.',
      wTargetActuation: W_TARGET_ACTUATION,
      stratum: "II-routine-only",
      highConsequenceAtomCount: 0,
      highConsequenceEarnedFraction: 0,
      iccFuelRequired: true,
    },
    readGrainDistribution: grainDist,
  };
}

export function decisionReadSlice(
  result: ThreeMetricM1Result,
  targetFraction: number = MEASUREMENT_A_TARGET,
): string {
  const sectionPlus = result.sliceByGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!;
  const corpusRead = result.corpusUniform.byGranularity.find(
    (g) => g.granularity === "section-plus-dependents",
  )!.earnedFractionAtReadGrain;

  const sliceRead = sectionPlus.sliceEarnedFractionAtReadGrain;
  const sliceAmend = sectionPlus.sliceEarnedFraction;
  const sliceN = result.coverage.adjudicatedAtomCount;

  // A tiny slice earning 100% is not decision-grade — the 05 spec's floor
  // principle ("n exceeds a small floor so two agreeing reviews cannot fake
  // precision") applies to the DECISION line too. Below the dense-signal
  // floor, report the slice honestly instead of a PASS.
  const SLICE_DECISION_FLOOR = 3;
  if (sliceN < SLICE_DECISION_FLOOR) {
    return `**INSUFFICIENT SLICE (n=${sliceN} adjudicated atoms < floor ${SLICE_DECISION_FLOOR}) — slice metric not decision-grade.** Citation-lineage attribution reached too few atoms for the slice fraction (${(sliceAmend * 100).toFixed(1)}%) to mean anything. Corpus-uniform contextualizer: ${(corpusRead * 100).toFixed(1)}%. Un-adjudicated tail: ${result.coverage.unAdjudicatedAtomCount} atoms (${(result.coverage.unAdjudicatedShare * 100).toFixed(1)}%) carry asserted-with-provenance. Match rate ${(result.caseMatchRate * 100).toFixed(1)}% (outcome-label heuristic). The bottleneck is deposit→atom lineage attribution, not earning arithmetic.`;
  }

  if (sliceAmend >= targetFraction) {
    return `**PASS (slice metric, n=${sliceN} adjudicated atoms).** Adjudication-weighted slice earns ${(sliceAmend * 100).toFixed(1)}% at section-plus-dependents (read-grain: ${(sliceRead * 100).toFixed(1)}%) vs ${(targetFraction * 100).toFixed(0)}% target. Corpus-uniform contextualizer: ${(corpusRead * 100).toFixed(1)}%. Un-adjudicated tail: ${result.coverage.unAdjudicatedAtomCount} atoms (${(result.coverage.unAdjudicatedShare * 100).toFixed(1)}%) carry asserted-with-provenance. Match rate ${(result.caseMatchRate * 100).toFixed(1)}%.`;
  }

  if (sliceRead >= targetFraction) {
    return `**Marginal PASS on slice read-grain** (${(sliceRead * 100).toFixed(1)}%) but amendment cadence filters slice to ${(sliceAmend * 100).toFixed(1)}%. Corpus-uniform: ${(corpusRead * 100).toFixed(1)}%. Target ${(targetFraction * 100).toFixed(0)}%.`;
  }

  return `**NO-GO (slice metric).** Adjudication-weighted slice earns ${(sliceRead * 100).toFixed(1)}% read-grain / ${(sliceAmend * 100).toFixed(1)}% with amendment at section-plus-dependents — below ${(targetFraction * 100).toFixed(0)}% target. Corpus-uniform contextualizer: ${(corpusRead * 100).toFixed(1)}%. ${result.coverage.adjudicatedAtomCount} adjudicated atoms vs ${result.coverage.unAdjudicatedAtomCount} asserted-tail (${(result.coverage.unAdjudicatedShare * 100).toFixed(1)}%).`;
}
