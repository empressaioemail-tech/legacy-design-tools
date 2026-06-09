/**
 * Engagement-scoped finding-run helpers — in-flight detection and
 * submission summary enrichment for architect triage surfaces.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db as prodDb, findingRuns, findings, submissions } from "@workspace/db";

export type FindingGenerationWireState =
  | "idle"
  | "pending"
  | "completed"
  | "failed";

export interface EngagementInFlightFindingRun {
  submissionId: string;
  generationId: string;
  state: "pending";
  startedAt: string;
}

export async function findEngagementInFlightFindingRun(
  engagementId: string,
  db: typeof prodDb = prodDb,
): Promise<EngagementInFlightFindingRun | null> {
  const [row] = await db
    .select({
      submissionId: findingRuns.submissionId,
      generationId: findingRuns.id,
      state: findingRuns.state,
      startedAt: findingRuns.startedAt,
    })
    .from(findingRuns)
    .innerJoin(submissions, eq(submissions.id, findingRuns.submissionId))
    .where(
      and(
        eq(submissions.engagementId, engagementId),
        eq(findingRuns.state, "pending"),
      ),
    )
    .orderBy(desc(findingRuns.startedAt))
    .limit(1);

  if (!row || row.state !== "pending") return null;
  return {
    submissionId: row.submissionId,
    generationId: row.generationId,
    state: "pending",
    startedAt: row.startedAt.toISOString(),
  };
}

export async function loadLatestFindingRunStateBySubmissionIds(
  submissionIds: string[],
  db: typeof prodDb = prodDb,
): Promise<
  Map<
    string,
    { state: FindingGenerationWireState; error: string | null }
  >
> {
  const map = new Map<
    string,
    { state: FindingGenerationWireState; error: string | null }
  >();
  if (submissionIds.length === 0) return map;

  const rows = await db
    .selectDistinctOn([findingRuns.submissionId], {
      submissionId: findingRuns.submissionId,
      state: findingRuns.state,
      error: findingRuns.error,
    })
    .from(findingRuns)
    .where(inArray(findingRuns.submissionId, submissionIds))
    .orderBy(findingRuns.submissionId, desc(findingRuns.startedAt));

  for (const row of rows) {
    map.set(row.submissionId, {
      state: row.state as FindingGenerationWireState,
      error: row.error,
    });
  }
  return map;
}

export async function loadOpenFindingCountBySubmissionIds(
  submissionIds: string[],
  db: typeof prodDb = prodDb,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (submissionIds.length === 0) return map;

  const rows = await db
    .select({
      submissionId: findings.submissionId,
      count: sql<number>`count(*)::int`,
    })
    .from(findings)
    .where(
      and(
        inArray(findings.submissionId, submissionIds),
        sql`${findings.status} <> 'overridden'`,
      ),
    )
    .groupBy(findings.submissionId);

  for (const row of rows) {
    map.set(row.submissionId, row.count);
  }
  return map;
}
