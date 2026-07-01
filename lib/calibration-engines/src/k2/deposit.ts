import type { K2BacktestDepositRow } from "./retrodiction.js";

/** Aggregate observed adjudication rate per atom from K2 deposits. */
export function observedAdjudicationRatesFromDeposits(
  deposits: readonly K2BacktestDepositRow[],
  observationYears: number,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const deposit of deposits) {
    for (const citation of deposit.citations) {
      counts.set(citation.atomId, (counts.get(citation.atomId) ?? 0) + 1);
    }
  }

  const rates = new Map<string, number>();
  for (const [atomId, count] of counts) {
    rates.set(atomId, count / Math.max(observationYears, 1));
  }
  return rates;
}

export function aggregateObservedRate(deposits: readonly K2BacktestDepositRow[]): number {
  if (deposits.length === 0) return 0;
  const successes = deposits.reduce(
    (s, d) => s + (d.payload.rawCounts.successCount ?? 0),
    0,
  );
  const trials = deposits.reduce(
    (s, d) => s + (d.payload.rawCounts.trialCount ?? 0),
    0,
  );
  return trials > 0 ? successes / trials : 0;
}
