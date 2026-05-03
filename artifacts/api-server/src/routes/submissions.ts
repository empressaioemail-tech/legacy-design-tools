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
  findings,
  submissions,
  SUBMISSION_STATUS_VALUES,
  type SubmissionStatus,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

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

const QUEUE_ORDER_VALUES = ["submittedAt", "respondedAt"] as const;
type QueueOrder = (typeof QUEUE_ORDER_VALUES)[number];

function isSubmissionStatus(v: string): v is SubmissionStatus {
  return (SUBMISSION_STATUS_VALUES as readonly string[]).includes(v);
}

function isQueueOrder(v: string): v is QueueOrder {
  return (QUEUE_ORDER_VALUES as readonly string[]).includes(v);
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

  const orderRaw = req.query.order;
  let order: QueueOrder = "submittedAt";
  if (typeof orderRaw === "string" && orderRaw.length > 0) {
    if (!isQueueOrder(orderRaw)) {
      res.status(400).json({
        error: "Invalid order",
        detail: `order must be one of: ${QUEUE_ORDER_VALUES.join(", ")}`,
      });
      return;
    }
    order = orderRaw;
  }

  // For `respondedAt` ordering, push null `respondedAt` rows
  // (anything that hasn't been responded to yet) to the bottom and
  // fall back to `submittedAt` as a tiebreaker so the slot is still
  // deterministic. Postgres' default for `DESC` is NULLS FIRST,
  // which would otherwise float pending rows to the top of the
  // Approved/Rejected lists.
  const orderByClause =
    order === "respondedAt"
      ? [
          sql`${submissions.respondedAt} DESC NULLS LAST`,
          desc(submissions.submittedAt),
        ]
      : [desc(submissions.submittedAt)];

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
    .orderBy(...orderByClause);

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
    approved: byStatus.approved,
    rejected: byStatus.rejected,
    backlog: byStatus.pending + byStatus.corrections_requested,
  };

  const kpis = await computeReviewerKpis();

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
    kpis,
  });
});

const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

type KpiMetric = {
  value: number | null;
  trend: "up" | "down" | null;
  trendLabel: string | null;
};

/**
 * Build a `{value, trend, trendLabel}` triple from the current and
 * prior window samples. `value` is null when the current window has
 * no data; trend is null when the prior window has no data (no
 * comparable baseline). The label always reads "X% vs prior 30d" so
 * the FE can render it verbatim.
 */
function buildKpiMetric(
  current: number | null,
  prior: number | null,
): KpiMetric {
  if (current == null) {
    return { value: null, trend: null, trendLabel: null };
  }
  if (prior == null || prior === 0) {
    return { value: current, trend: null, trendLabel: null };
  }
  const deltaPct = ((current - prior) / prior) * 100;
  const trend: "up" | "down" = deltaPct >= 0 ? "up" : "down";
  const magnitude = Math.abs(deltaPct);
  const formatted =
    magnitude >= 10 ? Math.round(magnitude).toString() : magnitude.toFixed(1);
  return {
    value: current,
    trend,
    trendLabel: `${formatted}% vs prior ${WINDOW_DAYS}d`,
  };
}

async function computeReviewerKpis(): Promise<{
  avgReviewTime: KpiMetric;
  aiAccuracy: KpiMetric;
  complianceRate: KpiMetric;
}> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const priorStart = new Date(now.getTime() - 2 * WINDOW_MS);

  // AVG REVIEW TIME — mean (responded_at - submitted_at) in hours,
  // bucketed by which 30-day window the response landed in.
  const reviewTimeRows = await db
    .select({
      bucket: sql<string>`CASE
        WHEN ${submissions.respondedAt} >= ${windowStart} THEN 'current'
        ELSE 'prior'
      END`,
      avgHours: sql<string | null>`AVG(EXTRACT(EPOCH FROM (${submissions.respondedAt} - ${submissions.submittedAt})) / 3600.0)`,
    })
    .from(submissions)
    .where(
      and(
        isNotNull(submissions.respondedAt),
        gte(submissions.respondedAt, priorStart),
        lt(submissions.respondedAt, now),
      ),
    )
    .groupBy(sql`1`);

  let avgReviewCurrent: number | null = null;
  let avgReviewPrior: number | null = null;
  for (const row of reviewTimeRows) {
    const v = row.avgHours == null ? null : Number(row.avgHours);
    if (row.bucket === "current") avgReviewCurrent = v;
    else if (row.bucket === "prior") avgReviewPrior = v;
  }

  // COMPLIANCE RATE — approved / (approved + corrections_requested + rejected)
  // bucketed by response window.
  const complianceRows = await db
    .select({
      bucket: sql<string>`CASE
        WHEN ${submissions.respondedAt} >= ${windowStart} THEN 'current'
        ELSE 'prior'
      END`,
      approved: sql<number>`SUM(CASE WHEN ${submissions.status} = 'approved' THEN 1 ELSE 0 END)::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(submissions)
    .where(
      and(
        isNotNull(submissions.respondedAt),
        gte(submissions.respondedAt, priorStart),
        lt(submissions.respondedAt, now),
        inArray(submissions.status, [
          "approved",
          "corrections_requested",
          "rejected",
        ]),
      ),
    )
    .groupBy(sql`1`);

  let complianceCurrent: number | null = null;
  let compliancePrior: number | null = null;
  for (const row of complianceRows) {
    const total = Number(row.total);
    if (total === 0) continue;
    const pct = (Number(row.approved) / total) * 100;
    if (row.bucket === "current") complianceCurrent = pct;
    else if (row.bucket === "prior") compliancePrior = pct;
  }

  // AI ACCURACY — accepted-or-promoted / (accepted+promoted+rejected+overridden)
  // bucketed by reviewer_status_changed_at window. `ai-produced` rows
  // are excluded — they have not been judged yet.
  const accuracyRows = await db
    .select({
      bucket: sql<string>`CASE
        WHEN ${findings.reviewerStatusChangedAt} >= ${windowStart} THEN 'current'
        ELSE 'prior'
      END`,
      accepted: sql<number>`SUM(CASE WHEN ${findings.status} IN ('accepted', 'promoted-to-architect') THEN 1 ELSE 0 END)::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(findings)
    .where(
      and(
        isNotNull(findings.reviewerStatusChangedAt),
        gte(findings.reviewerStatusChangedAt, priorStart),
        lt(findings.reviewerStatusChangedAt, now),
        inArray(findings.status, [
          "accepted",
          "rejected",
          "overridden",
          "promoted-to-architect",
        ]),
      ),
    )
    .groupBy(sql`1`);

  let accuracyCurrent: number | null = null;
  let accuracyPrior: number | null = null;
  for (const row of accuracyRows) {
    const total = Number(row.total);
    if (total === 0) continue;
    const pct = (Number(row.accepted) / total) * 100;
    if (row.bucket === "current") accuracyCurrent = pct;
    else if (row.bucket === "prior") accuracyPrior = pct;
  }

  return {
    avgReviewTime: buildKpiMetric(avgReviewCurrent, avgReviewPrior),
    aiAccuracy: buildKpiMetric(accuracyCurrent, accuracyPrior),
    complianceRate: buildKpiMetric(complianceCurrent, compliancePrior),
  };
}

export default router;
