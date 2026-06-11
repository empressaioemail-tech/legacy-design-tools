/**
 * Rehydrate engine-api JSON spine responses to in-process Date contracts.
 *
 * Spine HTTP responses serialize `Date` fields as ISO-8601 strings. Drizzle
 * timestamp columns and downstream consumers expect real `Date` objects — the
 * same shape local engines return in-process.
 *
 * Apply typed rehydrators at the routing boundary for each spine engine whose
 * response is persisted through drizzle `timestamp` columns. ISO strings stored
 * intentionally as plain text in JSON payloads (e.g. hydrology `fetchedAt`,
 * `computedAt`) must NOT be coerced here.
 */

import type { GenerateBriefingResult } from "@workspace/briefing-engine";
import type {
  EngineFinding,
  GenerateFindingsResult,
  GenerateOrchestratedFindingsResult,
} from "@workspace/finding-engine";
import type {
  FetchUsgs3depDemResult,
  HydrologyWorkerResult,
  RainfallForcingSource,
} from "@workspace/site-context/server";

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function rehydrateEngineFinding(finding: EngineFinding): EngineFinding {
  const aiGeneratedAt = toDate(finding.aiGeneratedAt);
  if (!aiGeneratedAt) {
    throw new Error(
      `spine finding ${finding.atomId}: aiGeneratedAt is not a Date or ISO string`,
    );
  }
  return { ...finding, aiGeneratedAt };
}

/** Rehydrate date fields on a spine {@link GenerateFindingsResult}. */
export function rehydrateSpineFindingsResult<
  T extends GenerateFindingsResult | GenerateOrchestratedFindingsResult,
>(result: T): T {
  const generatedAt = toDate(result.generatedAt);
  if (!generatedAt) {
    throw new Error("spine findings result: generatedAt is not a Date or ISO string");
  }
  return {
    ...result,
    findings: result.findings.map(rehydrateEngineFinding),
    generatedAt,
  };
}

/** Rehydrate date fields on a spine {@link GenerateBriefingResult}. */
export function rehydrateSpineBriefingResult(
  result: GenerateBriefingResult,
): GenerateBriefingResult {
  const generatedAt = toDate(result.generatedAt);
  if (!generatedAt) {
    throw new Error("spine briefing result: generatedAt is not a Date or ISO string");
  }
  return { ...result, generatedAt };
}

/**
 * Spine hydrology worker — audited: response has no Date-typed fields that
 * persist through drizzle timestamp columns (GeoJSON + string metadata only).
 */
export function rehydrateSpineHydrologyWorkerResult(
  result: HydrologyWorkerResult,
): HydrologyWorkerResult {
  return result;
}

/**
 * Spine rainfall forcing — audited: `estimate.fetchedAt` is an ISO string kept
 * in atom JSON payloads, not a drizzle timestamp column.
 */
export function rehydrateSpineRainfallForcingSource(
  result: RainfallForcingSource,
): RainfallForcingSource {
  return result;
}

/**
 * Spine USGS 3DEP DEM fetch — audited: `fetchedAt` is an ISO string in atom
 * payloads; the routing layer stamps it locally after decode.
 */
export function rehydrateSpineFetchUsgs3depDemResult(
  result: FetchUsgs3depDemResult,
): FetchUsgs3depDemResult {
  return result;
}
