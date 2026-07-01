import { N_STAR_FLOOR, S0_DEFAULT, W_TARGET } from "./constants.js";

/** Beta prior hyperparameters from asserted baseline mu0 and strength s0. */
export function betaPriorFromAsserted(mu0: number, s0: number = S0_DEFAULT): {
  alpha0: number;
  beta0: number;
} {
  const mu = Math.min(0.99, Math.max(0.01, mu0));
  return { alpha0: mu * s0, beta0: (1 - mu) * s0 };
}

/**
 * 90% equal-tailed credible interval width for Beta(α, β).
 * Normal approximation — adequate for planning n* at s0 ≥ 4.
 */
export function betaCredibleIntervalWidth90(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 1;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  return 2 * 1.645 * sd;
}

/**
 * Minimum adjudication count n*_i at which posterior 90% CI width drops below
 * W_target, using expected success rate k ≈ round(n · mu0).
 */
export function computeNStar(args: {
  mu0: number;
  s0?: number;
  wTarget?: number;
  nFloor?: number;
  maxSearch?: number;
}): number {
  const { alpha0, beta0 } = betaPriorFromAsserted(
    args.mu0,
    args.s0 ?? S0_DEFAULT,
  );
  const wTarget = args.wTarget ?? W_TARGET;
  const nFloor = args.nFloor ?? N_STAR_FLOOR;
  const maxSearch = args.maxSearch ?? 500;

  for (let n = nFloor; n <= maxSearch; n++) {
    const k = Math.round(n * args.mu0);
    const width = betaCredibleIntervalWidth90(alpha0 + k, beta0 + n - k);
    if (width < wTarget) return n;
  }
  return maxSearch + 1;
}

export type NStarDistribution = {
  min: number;
  max: number;
  median: number;
  p90: number;
  mean: number;
  count: number;
};

export function summarizeNStarDistribution(values: readonly number[]): NStarDistribution {
  if (values.length === 0) {
    return { min: 0, max: 0, median: 0, p90: 0, mean: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p90Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
  const medIdx = Math.floor(sorted.length / 2);
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    median: sorted[medIdx]!,
    p90: sorted[p90Idx]!,
    mean: sum / sorted.length,
    count: sorted.length,
  };
}
