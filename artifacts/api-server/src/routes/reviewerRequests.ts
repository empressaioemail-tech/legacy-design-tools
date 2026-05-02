import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  engagements,
  reviewerRequests,
  REVIEWER_REQUEST_KINDS,
  REVIEWER_REQUEST_TARGET_TYPES,
  type ReviewerRequest,
  type ReviewerRequestKind,
  type ReviewerRequestStatus,
  type ReviewerRequestTargetType,
  type ReviewerRequestActor,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  CreateEngagementReviewerRequestBody,
  CreateEngagementReviewerRequestParams,
  DismissReviewerRequestBody,
  DismissReviewerRequestParams,
  ListEngagementReviewerRequestsParams,
  ListEngagementReviewerRequestsQueryParams,
  ListMyReviewerRequestsQueryParams,
  WithdrawReviewerRequestBody,
  WithdrawReviewerRequestParams,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  REVIEWER_REQUEST_EVENT_TYPES,
  REVIEWER_REQUEST_KIND_TO_TARGET_TYPE,
  type ReviewerRequestEventType,
} from "../atoms/reviewer-request.atom";
import { hydrateActors } from "../lib/userLookup";

const router: IRouter = Router();

// Compile-time guard that emitted event-type literals stay in sync
// with the atom registration vocabulary.
type _EmittedRequestEventTypes =
  `reviewer-request.${ReviewerRequestKind}.requested`;
type _EmittedDismissEventTypes =
  `reviewer-request.${ReviewerRequestKind}.dismissed`;
type _EmittedWithdrawEventTypes =
  `reviewer-request.${ReviewerRequestKind}.withdrawn`;
type _EmittedEventTypesAreDeclared =
  | _EmittedRequestEventTypes
  | _EmittedDismissEventTypes
  | _EmittedWithdrawEventTypes extends (typeof REVIEWER_REQUEST_EVENT_TYPES)[number]
  ? true
  : never;

// Reviewer-only audience gate. Returns true after sending a 403.
function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "reviewer_requests_require_internal_audience" });
  return true;
}

// Architect-only audience gate. Returns true after sending a 403.
function requireArchitectAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "user") return false;
  res
    .status(403)
    .json({ error: "reviewer_requests_require_architect_audience" });
  return true;
}

// Read-side gate for the engagement-scoped reviewer-request list.
// Both architect (`user`) and reviewer (`internal`) audiences need
// to read it: architect drives the open-queue strip; reviewer reads
// it to bind Request-Refresh affordances to a pending state and
// avoid duplicate filings. Mutations stay split (architect-only
// dismiss, reviewer-only create). `ai` is rejected.
function requireArchitectOrReviewerAudience(
  req: Request,
  res: Response,
): boolean {
  if (req.session.audience === "user") return false;
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "reviewer_requests_require_architect_or_reviewer_audience" });
  return true;
}

// Resolve the actor envelope to stamp on `requested_by` /
// `dismissed_by`. Best-effort displayName hydration.
async function actorEnvelopeFromRequest(
  req: Request,
): Promise<ReviewerRequestActor | null> {
  const requestor = req.session.requestor;
  if (!requestor || !requestor.id) return null;
  let displayName: string | null = null;
  try {
    const [hydrated] = await hydrateActors([
      { kind: requestor.kind, id: requestor.id },
    ]);
    displayName = hydrated?.displayName ?? null;
  } catch {
    displayName = null;
  }
  return {
    kind: requestor.kind,
    id: requestor.id,
    displayName,
  };
}

// Wire envelope mirroring the `ReviewerRequest` OpenAPI schema.
interface ReviewerRequestWire {
  id: string;
  engagementId: string;
  requestKind: ReviewerRequestKind;
  targetEntityType: ReviewerRequestTargetType;
  targetEntityId: string;
  reason: string;
  status: ReviewerRequestStatus;
  requestedBy: ReviewerRequestActor;
  requestedAt: string;
  dismissedBy: ReviewerRequestActor | null;
  dismissedAt: string | null;
  dismissalReason: string | null;
  withdrawnBy: ReviewerRequestActor | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  resolvedAt: string | null;
  triggeredActionEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWire(row: ReviewerRequest): ReviewerRequestWire {
  return {
    id: row.id,
    engagementId: row.engagementId,
    requestKind: row.requestKind as ReviewerRequestKind,
    targetEntityType: row.targetEntityType as ReviewerRequestTargetType,
    targetEntityId: row.targetEntityId,
    reason: row.reason,
    status: row.status as ReviewerRequestStatus,
    requestedBy: row.requestedBy as ReviewerRequestActor,
    requestedAt: row.requestedAt.toISOString(),
    dismissedBy: (row.dismissedBy as ReviewerRequestActor | null) ?? null,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    dismissalReason: row.dismissalReason,
    withdrawnBy: (row.withdrawnBy as ReviewerRequestActor | null) ?? null,
    withdrawnAt: row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
    withdrawalReason: row.withdrawalReason,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    triggeredActionEventId: row.triggeredActionEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Append a `reviewer-request.<kind>.<lifecycle>` event scoped to the
// request row. Best-effort — a history outage cannot fail the HTTP
// request.
async function emitReviewerRequestEvent(
  history: EventAnchoringService,
  params: {
    request: ReviewerRequest;
    eventType: ReviewerRequestEventType;
    actor: ReviewerRequestActor;
    payload: Record<string, unknown>;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "reviewer-request",
      entityId: params.request.id,
      eventType: params.eventType,
      actor: { kind: params.actor.kind, id: params.actor.id },
      payload: params.payload,
    });
    reqLog.info(
      {
        reviewerRequestId: params.request.id,
        engagementId: params.request.engagementId,
        eventType: params.eventType,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      `${params.eventType} event appended`,
    );
  } catch (err) {
    reqLog.warn(
      {
        err,
        reviewerRequestId: params.request.id,
        engagementId: params.request.engagementId,
        eventType: params.eventType,
      },
      `${params.eventType} event append failed — row write kept`,
    );
  }
}

async function loadEngagement(engagementId: string) {
  const rows = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  return rows[0] ?? null;
}

async function loadReviewerRequest(
  requestId: string,
): Promise<ReviewerRequest | null> {
  const rows = await db
    .select()
    .from(reviewerRequests)
    .where(eq(reviewerRequests.id, requestId))
    .limit(1);
  return rows[0] ?? null;
}

// Cross-engagement reviewer-side list. Reviewer-only; ownership
// scoped server-side by `requested_by ->> 'id'` against the session
// requestor — the client cannot widen the scope. Defaults to
// `status=pending`; pass `status=all` to return every lifecycle
// state.
router.get(
  "/reviewer-requests",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const query = ListMyReviewerRequestsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query_params" });
      return;
    }
    const requestor = req.session.requestor;
    if (!requestor || !requestor.id) {
      reqLog.warn(
        { audience: req.session.audience },
        "reviewer-requests cross-engagement list rejected — internal audience without requestor",
      );
      res.status(400).json({ error: "missing_requestor" });
      return;
    }

    const rawStatus = query.data.status ?? "pending";
    const statusFilter: ReviewerRequestStatus | "all" = rawStatus;

    const requestedById = sql`${reviewerRequests.requestedBy} ->> 'id'`;
    const requestedByKind = sql`${reviewerRequests.requestedBy} ->> 'kind'`;

    const ownership = and(
      sql`${requestedById} = ${requestor.id}`,
      sql`${requestedByKind} = ${requestor.kind}`,
    );
    const where =
      statusFilter === "all"
        ? ownership
        : and(eq(reviewerRequests.status, statusFilter), ownership);

    const rows = await db
      .select({
        request: reviewerRequests,
        engagement: {
          id: engagements.id,
          name: engagements.name,
          jurisdiction: engagements.jurisdiction,
        },
      })
      .from(reviewerRequests)
      .innerJoin(
        engagements,
        eq(reviewerRequests.engagementId, engagements.id),
      )
      .where(where)
      .orderBy(desc(reviewerRequests.requestedAt));

    reqLog.debug(
      {
        requestorId: requestor.id,
        requestorKind: requestor.kind,
        statusFilter,
        count: rows.length,
      },
      "listed cross-engagement reviewer requests",
    );

    res.json({
      requests: rows.map((r) => ({
        ...toWire(r.request),
        engagement: {
          id: r.engagement.id,
          name: r.engagement.name,
          jurisdiction: r.engagement.jurisdiction,
        },
      })),
    });
  },
);

router.get(
  "/engagements/:id/reviewer-requests",
  async (req: Request, res: Response): Promise<void> => {
    // Task #429 — read access is now widened from architect-only to
    // architect-OR-reviewer so the reviewer-side Request-Refresh
    // affordances can bind to the same per-engagement list query
    // and disable themselves on a matching `pending` row. Mutations
    // remain split (reviewer-only POST, architect-only dismiss).
    if (requireArchitectOrReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = ListEngagementReviewerRequestsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const query = ListEngagementReviewerRequestsQueryParams.safeParse(
      req.query,
    );
    if (!query.success) {
      res.status(400).json({ error: "invalid_query_params" });
      return;
    }
    const engagement = await loadEngagement(params.data.id);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const filters = [eq(reviewerRequests.engagementId, engagement.id)];
    if (query.data.status) {
      filters.push(eq(reviewerRequests.status, query.data.status));
    }
    const rows = await db
      .select()
      .from(reviewerRequests)
      .where(and(...filters))
      .orderBy(desc(reviewerRequests.requestedAt));

    reqLog.debug(
      {
        engagementId: engagement.id,
        statusFilter: query.data.status ?? null,
        count: rows.length,
      },
      "listed reviewer requests",
    );
    res.json({ requests: rows.map(toWire) });
  },
);

router.post(
  "/engagements/:id/reviewer-requests",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = CreateEngagementReviewerRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = CreateEngagementReviewerRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const engagement = await loadEngagement(params.data.id);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const { requestKind, targetEntityType, targetEntityId, reason } =
      body.data;

    const expectedTargetType =
      REVIEWER_REQUEST_KIND_TO_TARGET_TYPE[
        requestKind as ReviewerRequestKind
      ];
    if (targetEntityType !== expectedTargetType) {
      res.status(400).json({
        error: "request_kind_target_type_mismatch",
        details: {
          requestKind,
          targetEntityType,
          expectedTargetType,
        },
      });
      return;
    }

    const actor = await actorEnvelopeFromRequest(req);
    if (!actor) {
      reqLog.warn(
        { engagementId: engagement.id, requestKind },
        "reviewer-request create rejected — internal audience without requestor",
      );
      res.status(400).json({ error: "missing_requestor" });
      return;
    }

    const inserted = await db
      .insert(reviewerRequests)
      .values({
        engagementId: engagement.id,
        requestKind,
        targetEntityType,
        targetEntityId,
        reason,
        status: "pending",
        requestedBy: actor,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      reqLog.error(
        { engagementId: engagement.id, requestKind },
        "reviewer-request insert returned no row",
      );
      res.status(500).json({ error: "Failed to create reviewer-request" });
      return;
    }

    const eventType =
      `reviewer-request.${requestKind}.requested` as ReviewerRequestEventType;
    await emitReviewerRequestEvent(
      getHistoryService(),
      {
        request: row,
        eventType,
        actor,
        payload: {
          engagementId: row.engagementId,
          requestKind: row.requestKind,
          targetEntityType: row.targetEntityType,
          targetEntityId: row.targetEntityId,
          reason: row.reason,
        },
      },
      reqLog,
    );

    res.status(201).json({ request: toWire(row) });
  },
);

router.post(
  "/reviewer-requests/:id/dismiss",
  async (req: Request, res: Response): Promise<void> => {
    if (requireArchitectAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = DismissReviewerRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = DismissReviewerRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const existing = await loadReviewerRequest(params.data.id);
    if (!existing) {
      res.status(404).json({ error: "reviewer_request_not_found" });
      return;
    }
    if (existing.status === "dismissed") {
      reqLog.debug(
        { reviewerRequestId: existing.id },
        "reviewer-request already dismissed — returning existing envelope",
      );
      res.status(200).json({ request: toWire(existing) });
      return;
    }
    if (existing.status === "resolved") {
      res.status(409).json({
        error: "reviewer_request_already_resolved",
        details: {
          resolvedAt: existing.resolvedAt
            ? existing.resolvedAt.toISOString()
            : null,
          triggeredActionEventId: existing.triggeredActionEventId,
        },
      });
      return;
    }

    const actor = await actorEnvelopeFromRequest(req);
    if (!actor) {
      reqLog.warn(
        { reviewerRequestId: existing.id },
        "reviewer-request dismiss rejected — architect audience without requestor",
      );
      res.status(400).json({ error: "missing_requestor" });
      return;
    }

    const updated = await db
      .update(reviewerRequests)
      .set({
        status: "dismissed",
        dismissedBy: actor,
        dismissedAt: new Date(),
        dismissalReason: body.data.dismissalReason,
        updatedAt: new Date(),
      })
      .where(eq(reviewerRequests.id, existing.id))
      .returning();
    const row = updated[0];
    if (!row) {
      reqLog.error(
        { reviewerRequestId: existing.id },
        "reviewer-request dismiss UPDATE returned no row",
      );
      res.status(500).json({ error: "Failed to dismiss reviewer-request" });
      return;
    }

    const eventType =
      `reviewer-request.${row.requestKind}.dismissed` as ReviewerRequestEventType;
    await emitReviewerRequestEvent(
      getHistoryService(),
      {
        request: row,
        eventType,
        actor,
        payload: {
          engagementId: row.engagementId,
          requestKind: row.requestKind,
          targetEntityType: row.targetEntityType,
          targetEntityId: row.targetEntityId,
          dismissalReason: row.dismissalReason,
        },
      },
      reqLog,
    );

    res.status(200).json({ request: toWire(row) });
  },
);

router.post(
  "/reviewer-requests/:id/withdraw",
  async (req: Request, res: Response): Promise<void> => {
    // Reviewer-side retract path (Task #443). Mirrors the architect
    // dismiss endpoint structurally but is gated on the *reviewer*
    // audience AND on row ownership — only the original requester
    // can clear their own outstanding ask. The 9-event vocabulary
    // keeps `*.withdrawn` distinct from `*.dismissed` so the
    // engagement timeline can tell apart "architect declined" from
    // "reviewer changed their mind".
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = WithdrawReviewerRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = WithdrawReviewerRequestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const existing = await loadReviewerRequest(params.data.id);
    if (!existing) {
      res.status(404).json({ error: "reviewer_request_not_found" });
      return;
    }

    const actor = await actorEnvelopeFromRequest(req);
    if (!actor) {
      reqLog.warn(
        { reviewerRequestId: existing.id },
        "reviewer-request withdraw rejected — reviewer audience without requestor",
      );
      res.status(400).json({ error: "missing_requestor" });
      return;
    }

    // Author-only: the row's `requestedBy.id` + `kind` envelope must
    // exactly match the calling reviewer. We compare both fields so
    // a future cross-kind id collision can never grant withdraw
    // rights to a non-author. 403 (not 404) is the right code here:
    // the row exists and the caller's audience is correct, but they
    // are not the author.
    const requestedBy = existing.requestedBy as ReviewerRequestActor;
    if (
      requestedBy.id !== actor.id ||
      requestedBy.kind !== actor.kind
    ) {
      reqLog.warn(
        {
          reviewerRequestId: existing.id,
          callerId: actor.id,
          callerKind: actor.kind,
          requestedById: requestedBy.id,
          requestedByKind: requestedBy.kind,
        },
        "reviewer-request withdraw rejected — caller is not row author",
      );
      res
        .status(403)
        .json({ error: "reviewer_request_withdraw_requires_author" });
      return;
    }

    if (existing.status === "withdrawn") {
      // Idempotent in spirit — re-issuing withdraw on an already-
      // withdrawn row returns the existing envelope without re-
      // emitting an event, mirroring the dismiss-already-dismissed
      // precedent above.
      reqLog.debug(
        { reviewerRequestId: existing.id },
        "reviewer-request already withdrawn — returning existing envelope",
      );
      res.status(200).json({ request: toWire(existing) });
      return;
    }
    if (existing.status === "dismissed") {
      res.status(409).json({
        error: "reviewer_request_already_dismissed",
        details: {
          dismissedAt: existing.dismissedAt
            ? existing.dismissedAt.toISOString()
            : null,
          dismissalReason: existing.dismissalReason,
        },
      });
      return;
    }
    if (existing.status === "resolved") {
      res.status(409).json({
        error: "reviewer_request_already_resolved",
        details: {
          resolvedAt: existing.resolvedAt
            ? existing.resolvedAt.toISOString()
            : null,
          triggeredActionEventId: existing.triggeredActionEventId,
        },
      });
      return;
    }

    const withdrawalReason = body.data.withdrawalReason ?? null;

    const updated = await db
      .update(reviewerRequests)
      .set({
        status: "withdrawn",
        withdrawnBy: actor,
        withdrawnAt: new Date(),
        withdrawalReason,
        updatedAt: new Date(),
      })
      .where(eq(reviewerRequests.id, existing.id))
      .returning();
    const row = updated[0];
    if (!row) {
      reqLog.error(
        { reviewerRequestId: existing.id },
        "reviewer-request withdraw UPDATE returned no row",
      );
      res.status(500).json({ error: "Failed to withdraw reviewer-request" });
      return;
    }

    const eventType =
      `reviewer-request.${row.requestKind}.withdrawn` as ReviewerRequestEventType;
    await emitReviewerRequestEvent(
      getHistoryService(),
      {
        request: row,
        eventType,
        actor,
        payload: {
          engagementId: row.engagementId,
          requestKind: row.requestKind,
          targetEntityType: row.targetEntityType,
          targetEntityId: row.targetEntityId,
          withdrawalReason: row.withdrawalReason,
        },
      },
      reqLog,
    );

    res.status(200).json({ request: toWire(row) });
  },
);

void REVIEWER_REQUEST_KINDS;
void REVIEWER_REQUEST_TARGET_TYPES;

export default router;
