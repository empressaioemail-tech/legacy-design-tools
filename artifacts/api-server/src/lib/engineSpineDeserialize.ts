/**
 * Rehydrate engine-api JSON findings responses to in-process Date contracts.
 *
 * Spine HTTP responses serialize `Date` fields as ISO-8601 strings. Drizzle
 * timestamp columns and downstream consumers expect real `Date` objects — the
 * same shape the local finding-engine returns in-process.
 */

import type {
  EngineFinding,
  GenerateFindingsResult,
  GenerateOrchestratedFindingsResult,
} from "@workspace/finding-engine";

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
