/**
 * Unscoped reviewer reads for the plan-review BFF (`/api/plan-review/*`).
 * Internal reviewer tool — same posture as queue + engagement detail (#207).
 */
import { desc, eq } from "drizzle-orm";
import { db, engagements, submissions } from "@workspace/db";
import {
  loadLatestFindingRunStateBySubmissionIds,
  loadOpenFindingCountBySubmissionIds,
} from "./findingRunsEngagement";

export async function loadReviewerBffEngagement(engagementId: string) {
  const [row] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  return row ?? null;
}

export async function loadReviewerBffSubmission(submissionId: string) {
  const [row] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return row ?? null;
}

export async function listReviewerEngagementSubmissions(engagementId: string) {
  const engagement = await loadReviewerBffEngagement(engagementId);
  if (!engagement) return null;

  const rows = await db
    .select({
      id: submissions.id,
      submittedAt: submissions.submittedAt,
      jurisdiction: submissions.jurisdiction,
      note: submissions.note,
      discipline: submissions.discipline,
      status: submissions.status,
      reviewerComment: submissions.reviewerComment,
      respondedAt: submissions.respondedAt,
      responseRecordedAt: submissions.responseRecordedAt,
    })
    .from(submissions)
    .where(eq(submissions.engagementId, engagementId))
    .orderBy(desc(submissions.submittedAt));

  const submissionIds = rows.map((r) => r.id);
  const [runStateBySubmission, openCountBySubmission] = await Promise.all([
    loadLatestFindingRunStateBySubmissionIds(submissionIds),
    loadOpenFindingCountBySubmissionIds(submissionIds),
  ]);

  return rows.map((r) => {
    const run = runStateBySubmission.get(r.id);
    return {
      id: r.id,
      submittedAt: r.submittedAt.toISOString(),
      jurisdiction: r.jurisdiction,
      note: r.note,
      discipline: r.discipline,
      status: r.status,
      reviewerComment: r.reviewerComment,
      respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
      responseRecordedAt: r.responseRecordedAt
        ? r.responseRecordedAt.toISOString()
        : null,
      findingGenerationState: run?.state ?? "idle",
      findingGenerationError: run?.error ?? null,
      openFindingCount: openCountBySubmission.get(r.id) ?? 0,
    };
  });
}
