import { randomUUID } from "node:crypto";
import type { CodewarmCostRecord } from "./types";

export const DEFAULT_COST_PER_FETCH_USD = 0.002;

export interface CostTracker {
  batchId: string;
  startedAt: string;
  readonly fetchCount: number;
  readonly estimatedCostUsd: number;
  readonly budgetCapUsd: number | null;
  readonly haltedByBudget: boolean;
  chargeFetch: (costPerFetchUsd: number) => void;
  toRecord: (args: {
    manifestPath: string;
    jurisdictionKey: string;
  }) => CodewarmCostRecord;
}

export function createCostTracker(args: {
  budgetCapUsd?: number;
  batchId?: string;
}): CostTracker {
  const batchId = args.batchId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const budgetCapUsd = args.budgetCapUsd ?? null;
  let fetchCount = 0;
  let estimatedCostUsd = 0;
  let haltedByBudget = false;

  return {
    batchId,
    startedAt,
    get fetchCount() {
      return fetchCount;
    },
    get estimatedCostUsd() {
      return estimatedCostUsd;
    },
    get budgetCapUsd() {
      return budgetCapUsd;
    },
    get haltedByBudget() {
      return haltedByBudget;
    },
    chargeFetch(costPerFetchUsd: number) {
      fetchCount += 1;
      estimatedCostUsd += costPerFetchUsd;
      if (budgetCapUsd != null && estimatedCostUsd > budgetCapUsd) {
        haltedByBudget = true;
      }
    },
    toRecord({ manifestPath, jurisdictionKey }) {
      return {
        batchId,
        manifestPath,
        jurisdictionKey,
        fetchCount,
        estimatedCostUsd,
        budgetCapUsd,
        haltedByBudget,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    },
  };
}
