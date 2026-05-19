/**
 * Briefing-engine runner. Same shape as `findingEngine.ts` — pull the
 * engagement's source rows, hand them to `generateBriefing` in
 * anthropic mode, return the captured cost/latency.
 */

import {
  db,
  briefingSources,
  engagements,
  parcelBriefings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  generateBriefing,
  type BriefingSourceInput,
  type GenerateBriefingResult,
} from "@workspace/briefing-engine";
import type { InstrumentedAnthropicClient } from "../instrumentedClient";
import type { FixtureGroundTruth, RunnerSample } from "../types";

export interface BriefingEngineRunOutput {
  sample: RunnerSample;
  result: GenerateBriefingResult;
}

export async function runBriefingEngine(
  fixture: FixtureGroundTruth,
  instrumented: InstrumentedAnthropicClient,
): Promise<BriefingEngineRunOutput> {
  if (fixture.placeholder) {
    throw new Error(
      `Fixture ${fixture.key} is a placeholder: ${fixture.placeholder.blocker}`,
    );
  }
  if (!fixture.engagementId) {
    throw new Error(
      `Fixture ${fixture.key} missing engagementId — cannot run briefing engine`,
    );
  }

  const [engagement] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, fixture.engagementId));
  if (!engagement) {
    throw new Error(
      `Engagement ${fixture.engagementId} not found for fixture ${fixture.key}`,
    );
  }

  const [briefing] = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, fixture.engagementId));
  const sourceRows = briefing
    ? await db
        .select()
        .from(briefingSources)
        .where(eq(briefingSources.briefingId, briefing.id))
    : [];

  const sources: BriefingSourceInput[] = sourceRows.map((s) => ({
    id: s.id,
    layerKind: s.layerKind,
    sourceKind: s.sourceKind,
    provider: s.provider ?? null,
    snapshotDate: (s.snapshotDate ?? new Date()).toISOString(),
    note: s.note ?? null,
  }));

  const t0 = Date.now();
  const result = await generateBriefing(
    {
      engagementId: fixture.engagementId,
      engagementLabel: engagement.name,
      sources,
      generatedBy: "system:eval-harness",
    },
    {
      mode: "anthropic",
      anthropicClient: instrumented.client,
    },
  );
  const durationMs = Date.now() - t0;

  const anthropicCalls = instrumented.drain();

  return {
    sample: {
      engine: "briefing",
      durationMs,
      anthropicCalls,
      payload: result,
    },
    result,
  };
}
