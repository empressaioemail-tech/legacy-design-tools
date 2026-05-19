/**
 * Finding-engine runner. Builds the input bundle from the fixture's
 * engagement/submission, calls `generateFindings` in anthropic mode
 * with the instrumented client, returns a `RunnerSample` carrying the
 * result + per-call cost/latency capture.
 *
 * Mock-aware: the eval CLI sets mode explicitly to "anthropic" rather
 * than reading env, so eval results always reflect the real prompt
 * path even when the api-server is in mock mode.
 */

import {
  db,
  briefingSources,
  parcelBriefings,
  submissions,
  engagements,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  retrieveAtomsForQuestion,
  keyFromEngagement,
} from "@workspace/codes";
import {
  generateFindings,
  type BriefingSourceInput,
  type CodeSectionInput,
  type GenerateFindingsResult,
} from "@workspace/finding-engine";
import type { InstrumentedAnthropicClient } from "../instrumentedClient";
import type { FixtureGroundTruth, RunnerSample } from "../types";

export interface FindingEngineRunOutput {
  sample: RunnerSample;
  result: GenerateFindingsResult;
}

/**
 * Run the finding engine against one fixture. Throws if the fixture is
 * a placeholder or the engagement isn't seeded — the CLI catches and
 * records a `failed` eval_run row.
 */
export async function runFindingEngine(
  fixture: FixtureGroundTruth,
  instrumented: InstrumentedAnthropicClient,
): Promise<FindingEngineRunOutput> {
  if (fixture.placeholder) {
    throw new Error(
      `Fixture ${fixture.key} is a placeholder: ${fixture.placeholder.blocker}`,
    );
  }
  if (!fixture.engagementId || !fixture.submissionId) {
    throw new Error(
      `Fixture ${fixture.key} missing engagementId/submissionId — cannot run finding engine`,
    );
  }

  // Pull the submission + engagement so the engine input mirrors what
  // the api-server route would build at request time.
  const [submission] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, fixture.submissionId));
  if (!submission) {
    throw new Error(
      `Submission ${fixture.submissionId} not found for fixture ${fixture.key}`,
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

  // Build the briefing-source input list from the engagement's
  // parcel briefing. briefing_sources are scoped to a parcel briefing,
  // not directly to an engagement, so we hop through parcel_briefings
  // (which has a unique engagement_id, per the schema). When the
  // engagement has no parcel briefing yet, sources is an empty array
  // — the finding-engine handles zero sources fine, the citation rubric
  // just won't have any briefing-source citations to score.
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

  // Retrieve a top-K code-section reference set for the submission's
  // jurisdiction. The eval's seed question is the submission note when
  // present, falling back to the engagement label.
  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: engagement.jurisdictionCity ?? null,
    jurisdictionState: engagement.jurisdictionState ?? null,
    jurisdiction: engagement.jurisdiction ?? null,
    address: engagement.address ?? null,
  });

  const codeSections: CodeSectionInput[] = jurisdictionKey
    ? (
        await retrieveAtomsForQuestion({
          jurisdictionKey,
          question: submission.note ?? engagement.name,
          limit: 8,
        })
      ).map((a) => ({
        atomId: a.id,
        label: a.sectionTitle ?? a.sectionNumber ?? a.codeBook,
        snippet: a.body.slice(0, 600),
      }))
    : [];

  const t0 = Date.now();
  const result = await generateFindings(
    {
      submission: {
        id: submission.id,
        jurisdiction: submission.jurisdiction ?? null,
        projectName: engagement.name,
        note: submission.note ?? null,
      },
      sources,
      codeSections,
      bimElements: [],
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
      engine: "finding",
      durationMs,
      anthropicCalls,
      payload: result,
    },
    result,
  };
}
