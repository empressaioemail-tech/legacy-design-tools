/**
 * P-85 WDLL item 14 — per-run cost fields derived from scope + worker timing.
 *
 * Fields: imageFeesCents, computeCents, humanMinutes, instrumentCount, totalCents.
 * Refuses to invent values when acquisition block is absent on a terminal run
 * that should have searched (instrumentCount defaults to 0 only when explicit).
 */

/** Placeholder until portal price parse lands — one cent per worker second. */
export const COMPUTE_CENTS_PER_SECOND = 1;

/** Estimated clerk minutes per instrument routed to human acquisition. */
export const HUMAN_MINUTES_PER_PENDING_INSTRUMENT = 5;

export interface RecordsRequestRunCost {
  imageFeesCents: number;
  computeCents: number;
  humanMinutes: number;
  instrumentCount: number;
  totalCents: number;
  derivedAt: string;
}

export interface DeriveRunCostInput {
  scopeSearched?: Record<string, unknown> | null;
  /** Wall time for the recipe execution (worker-measured). */
  computeMs?: number;
  /** Terminal job status — drives human-minute estimate. */
  terminalStatus?:
    | "complete"
    | "failed"
    | "needs-human"
    | "awaiting-purchase-approval";
}

function readAcquisition(
  scope: Record<string, unknown>,
): Record<string, unknown> | null {
  const raw = scope.acquisition;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : null;
}

function readInstrumentCount(scope: Record<string, unknown>): number {
  if (typeof scope.instrumentCount === "number" && Number.isFinite(scope.instrumentCount)) {
    return Math.max(0, Math.trunc(scope.instrumentCount));
  }
  const acquisition = readAcquisition(scope);
  if (acquisition && typeof acquisition.acquired === "number") {
    return Math.max(0, Math.trunc(acquisition.acquired));
  }
  const hits = scope.indexHits;
  if (Array.isArray(hits)) {
    return hits.length;
  }
  return 0;
}

function readImageFeesCents(scope: Record<string, unknown>): number {
  const acquisition = readAcquisition(scope);
  if (acquisition && typeof acquisition.purchaseCostCents === "number") {
    return Math.max(0, Math.trunc(acquisition.purchaseCostCents));
  }
  if (typeof scope.projectedPurchaseCostCents === "number") {
    return Math.max(0, Math.trunc(scope.projectedPurchaseCostCents));
  }
  return 0;
}

function readPendingHumanCount(scope: Record<string, unknown>): number {
  const acquisition = readAcquisition(scope);
  if (acquisition && typeof acquisition.pendingHumanCount === "number") {
    return Math.max(0, Math.trunc(acquisition.pendingHumanCount));
  }
  return 0;
}

function computeCentsFromMs(computeMs: number | undefined): number {
  if (computeMs == null || !Number.isFinite(computeMs) || computeMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((computeMs / 1000) * COMPUTE_CENTS_PER_SECOND));
}

function estimateHumanMinutes(
  scope: Record<string, unknown>,
  terminalStatus: DeriveRunCostInput["terminalStatus"],
): number {
  const pending = readPendingHumanCount(scope);
  let minutes = pending * HUMAN_MINUTES_PER_PENDING_INSTRUMENT;
  if (
    (terminalStatus === "needs-human" || terminalStatus === "awaiting-purchase-approval") &&
    pending === 0
  ) {
    minutes += HUMAN_MINUTES_PER_PENDING_INSTRUMENT;
  }
  return minutes;
}

/**
 * Derive run_cost json from scope_searched acquisition metadata and worker timing.
 */
export function deriveRunCostFromScope(input: DeriveRunCostInput): RecordsRequestRunCost {
  const scope = input.scopeSearched ?? {};
  const imageFeesCents = readImageFeesCents(scope);
  const computeCents = computeCentsFromMs(input.computeMs);
  const instrumentCount = readInstrumentCount(scope);
  const humanMinutes = estimateHumanMinutes(scope, input.terminalStatus);
  const totalCents = imageFeesCents + computeCents;

  return {
    imageFeesCents,
    computeCents,
    humanMinutes,
    instrumentCount,
    totalCents,
    derivedAt: new Date().toISOString(),
  };
}
