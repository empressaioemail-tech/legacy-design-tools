/** Decision-relative W_target: coarse bar for ranking / moat-health (Measurement A). */
export const W_TARGET_RANKING = 0.35;

/** Tight bar for actuation gating on high-consequence tail — NOT used in M1-A first cut. */
export const W_TARGET_ACTUATION = 0.2;

/** Legacy uniform threshold (v1 model — superseded for M1 re-run). */
export const W_TARGET = 0.2;

/** Prior strength default (weak), encodes source quality — spec range 4–8. */
export const S0_DEFAULT = 6;

/** Minimum n so two agreeing reviews cannot fake precision (I3 grain rule). */
export const N_STAR_FLOOR = 3;

/** Minimum case signals before atom-grain read (matches engine-core MIN_DENSE_SIGNAL). */
export const MIN_DENSE_SIGNAL = 3;

/** Measurement A default target fraction (moat health). */
export const MEASUREMENT_A_TARGET = 0.7;

/**
 * F8 cold-start prior — amendments per section-year with zero amendment atoms.
 */
export const AMENDMENT_HAZARD_COLD_START_PRIOR = 0.02;

export const DEFAULT_CORPUS_BASELINE = 0.65;

export const SOURCE_QUALITY_BASELINE: Record<string, number> = {
  pdf: 0.82,
  api: 0.78,
  html: 0.72,
  web: 0.55,
  municode: 0.78,
};

/** Public partition key for anonymous + public-tier pooling (ADR-005/017). */
export const PUBLIC_PARTITION = "__public__" as const;
