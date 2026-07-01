/**
 * Case-grain earning + citation-lineage attribution (M1 amendment).
 *
 * The unit of earning is the prediction-against-outcome case. Signal deposits
 * onto cited atoms via findings.citations[].atomId — arrow two's existing path.
 */

import { PUBLIC_PARTITION } from "./constants.js";

export type PartitionKind = typeof PUBLIC_PARTITION | `tenant:${string}`;

export type CaseGrainSignal = {
  caseId: string;
  subjectKey: string;
  jurisdictionTenant: string;
  partition: PartitionKind;
  fuelProvenance: "backtest" | "live" | "seed" | "asserted";
  successCount: number;
  trialCount: number;
  citedAtomIds: string[];
  occurredAt: string;
};

export type K2DepositLike = {
  entityId: string;
  occurredAt: string;
  payload: {
    subjectKey?: string;
    calibrationProvenance?: string;
    rawCounts?: { successCount?: number; trialCount?: number };
  };
  citations: Array<{ kind: string; atomId: string }>;
  cortexJurisdictionKey?: string;
};

function jurisdictionFromDeposit(row: K2DepositLike): string {
  const key = row.payload.subjectKey ?? row.entityId;
  const match = /^([a-z_]+_tx):/.exec(key);
  if (match) return match[1]!;
  const city = row.cortexJurisdictionKey ?? "";
  if (city.includes("austin")) return "austin_tx";
  if (city.includes("san_antonio") || city.includes("san-antonio")) {
    return "san_antonio_tx";
  }
  if (city.includes("bastrop")) return "bastrop_tx";
  return "unknown";
}

/** K2 backtest public-record outcomes → public partition (Condition B). */
export function partitionForDeposit(row: K2DepositLike): PartitionKind {
  const prov = row.payload.calibrationProvenance ?? "backtest";
  if (prov === "backtest" || prov === "seed") return PUBLIC_PARTITION;
  return PUBLIC_PARTITION;
}

export function caseSignalsFromDeposits(
  deposits: readonly K2DepositLike[],
): CaseGrainSignal[] {
  return deposits
    .map((row) => {
      const citedAtomIds = row.citations
        .filter((c) => c.kind === "code-section" && c.atomId)
        .map((c) => c.atomId);
      if (citedAtomIds.length === 0) return null;

      const success = row.payload.rawCounts?.successCount ?? 0;
      const trial = row.payload.rawCounts?.trialCount ?? 1;

      return {
        caseId: row.entityId,
        subjectKey: row.payload.subjectKey ?? row.entityId,
        jurisdictionTenant: jurisdictionFromDeposit(row),
        partition: partitionForDeposit(row),
        fuelProvenance:
          (row.payload.calibrationProvenance as CaseGrainSignal["fuelProvenance"]) ??
          "backtest",
        successCount: success,
        trialCount: trial,
        citedAtomIds,
        occurredAt: row.occurredAt,
      };
    })
    .filter((s): s is CaseGrainSignal => s != null);
}

/** Attribute case signals to atom lineage buckets (Condition B: partition-scoped). */
export function buildLineageBuckets(
  cases: readonly CaseGrainSignal[],
): Map<string, CaseGrainSignal[]> {
  const buckets = new Map<string, CaseGrainSignal[]>();
  for (const c of cases) {
    for (const atomId of c.citedAtomIds) {
      const key = `${c.partition}::${atomId}`;
      const list = buckets.get(key) ?? [];
      list.push(c);
      buckets.set(key, list);
    }
  }
  return buckets;
}

export function aggregateCaseSignals(
  cases: readonly CaseGrainSignal[],
): { n: number; k: number } {
  let n = 0;
  let k = 0;
  for (const c of cases) {
    n += c.trialCount;
    k += c.successCount;
  }
  return { n, k };
}

export function observedCaseAdjudicationRate(
  cases: readonly CaseGrainSignal[],
  observationYears: number,
): number {
  if (cases.length === 0 || observationYears <= 0) return 0;
  return cases.length / observationYears;
}

export function caseMatchRate(cases: readonly CaseGrainSignal[]): number {
  if (cases.length === 0) return 0;
  const successes = cases.filter((c) => c.successCount > 0).length;
  return successes / cases.length;
}
