import type { InvalidationGranularity } from "./invalidation.js";
import type { NStarDistribution } from "./betaPosterior.js";

export type CodeSectionAtomInput = {
  atomId: string;
  jurisdictionTenant: string;
  /** Asserted baseline mu0 — from source quality. */
  mu0: number;
  /** Optional per-atom query weight (MCP atom-grain). */
  queryWeight?: number;
  /** Optional observed adjudication-and-outcome rate (K2). */
  adjudicationRate?: number;
  closureSize?: number;
};

export type QueryWeightMode = "available" | "uniform";

export type MeasurementAMode = "solve-for" | "observed";

export type GranularityResult = {
  granularity: InvalidationGranularity;
  /** Minimum uniform a driving fraction >= target (solve-for mode). */
  requiredAdjudicationRate: number | null;
  /** Weighted earned fraction when observed rates supplied. */
  observedFraction: number | null;
  earnedAtomCount: number;
  totalWeightedAtoms: number;
};

export type MeasurementAResult = {
  mode: MeasurementAMode;
  queryWeightMode: QueryWeightMode;
  targetFraction: number;
  lambdaPriorUsed: number;
  lambdaSource: "cold-start-prior" | "amendment-history";
  amendmentAtomCount: number;
  atomCount: number;
  nStarDistribution: NStarDistribution;
  byGranularity: GranularityResult[];
  measurementBDeferred: true;
  measurementBReason: string;
};
