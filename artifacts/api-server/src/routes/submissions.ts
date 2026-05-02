/**
 * GET /api/reviewer/queue — cross-engagement reviewer Inbox feed.
 * Reviewer-only (audience=internal). Returns submissions joined to
 * their parent engagement plus a denormalized status roll-up across
 * the whole submissions table.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  engagements,
  submissions,
  SUBMISSION_STATUS_VALUES,
  type SubmissionStatus,
} from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";

const router: IRouter = Router();

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "reviewer_queue_requires_internal_audience" });
  return true;
}

const DEFAULT_STATUS_FILTER: ReadonlyArray<SubmissionStatus> = [
  "pending",
  "corrections_requested",
];

function isSubmissionStatus(v: string): v is SubmissionStatus {
  return (SUBMISSION_STATUS_VALUES as readonly string[]).includes(v);
}

/**
 * Parse `?status=` CSV. Returns null when an unknown value is passed
 * (route turns into a 400). Empty / missing falls back to the default.
 */
function parseStatusFilter(
  raw: unknown,
): ReadonlyArray<SubmissionStatus> | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_STATUS_FILTER;
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return DEFAULT_STATUS_FILTER;
  const out: SubmissionStatus[] = [];
  const seen = new Set<SubmissionStatus>();
  for (const part of parts) {
    if (!isSubmissionStatus(part)) return null;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

router.get("/reviewer/queue", async (req: Request, res: Response) => {
  if (requireReviewerAudience(req, res)) return;

  const filter = parseStatusFilter(req.query.status);
  if (filter === null) {
    res.status(400).json({
      error: "Invalid status filter",
      detail: `status must be a comma-separated list of: ${SUBMISSION_STATUS_VALUES.join(", ")}`,
    });
    return;
  }

  const itemRows = await db
    .select({
      submissionId: submissions.id,
      engagementId: submissions.engagementId,
      engagementName: engagements.name,
      // Use the engagement's current jurisdiction/address (not the
      // submission's submit-time snapshot) so the Inbox reflects today's
      // engagement state — same precedent as EngagementsList.
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
      applicantFirm: engagements.applicantFirm,
      submittedAt: submissions.submittedAt,
      status: submissions.status,
      note: submissions.note,
      reviewerComment: submissions.reviewerComment,
    })
    .from(submissions)
    .innerJoin(engagements, eq(submissions.engagementId, engagements.id))
    .where(inArray(submissions.status, filter as SubmissionStatus[]))
    .orderBy(desc(submissions.submittedAt));

  const countRows = await db
    .select({
      status: submissions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(submissions)
    .groupBy(submissions.status);

  const byStatus: Record<SubmissionStatus, number> = {
    pending: 0,
    approved: 0,
    corrections_requested: 0,
    rejected: 0,
  };
  for (const row of countRows) {
    if (isSubmissionStatus(row.status)) {
      byStatus[row.status] = row.count;
    }
  }

  const counts = {
    awaitingAi: byStatus.pending,
    inReview: byStatus.corrections_requested,
    rejected: byStatus.rejected,
    backlog: byStatus.pending + byStatus.corrections_requested,
  };

  res.json({
    items: itemRows.map((r) => ({
      submissionId: r.submissionId,
      engagementId: r.engagementId,
      engagementName: r.engagementName,
      jurisdiction: r.jurisdiction,
      address: r.address,
      applicantFirm: r.applicantFirm,
      submittedAt:
        r.submittedAt instanceof Date
          ? r.submittedAt.toISOString()
          : r.submittedAt,
      status: r.status as SubmissionStatus,
      note: r.note,
      reviewerComment: r.reviewerComment,
    })),
    counts,
  });
});

export default router;
