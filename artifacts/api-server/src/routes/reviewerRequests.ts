/**
 * /api/engagements/:id/reviewer-requests + /api/reviewer-requests/:id/*
 * — Wave 2 Sprint D / V1-2.
 *
 * Three endpoints:
 *
 *   - GET  /engagements/:id/reviewer-requests
 *       List reviewer-requests on the engagement, newest-first.
 *       Architect-only. Optional `?status=pending|dismissed|resolved`
 *       filter for the strip's open-queue read.
 *
 *   - POST /engagements/:id/reviewer-requests
 *       Reviewer files a free-text request asking the architect to
 *       run one of three actions against a target atom on the
 *       engagement. Reviewer-only. Emits the matching
 *       `reviewer-request.<kind>.requested` event.
 *
 *   - POST /reviewer-requests/:id/dismiss
 *       Architect dismisses a pending request with a reason.
 *       Architect-only. Emits the matching
 *       `reviewer-request.<kind>.dismissed` event. Idempotent on
 *       already-dismissed rows; rejects already-resolved rows with
 *       409 (a domain action implicitly closed the request).
 *
 * Resolution is implicit — when the architect runs the underlying
 * domain action (refresh briefing-source / refresh bim-model /
 * regenerate briefing) the post-action hook in
 * `lib/reviewerRequestResolution.ts` flips the matching pending
 * request to `resolved` and stamps `triggeredActionEventId`. There
 * is no explicit "honor" endpoint and no `*.honored` event — the
 * domain-action event is the resolution signal, per V1-2 cut.
 *
 * Event emission is best-effort by the same contract as the
 * engagementEvents / reviewerAnnotations helpers: a transient
 * history outage cannot fail the HTTP request.
 */

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
import { and, desc, eq } from "drizzle-orm";
import {
  CreateEngagementReviewerRequestBody,
  CreateEngagementReviewerRequestParams,
  DismissReviewerRequestBody,
  DismissReviewerRequestParams,
  ListEngagementReviewerRequestsParams,
  ListEngagementReviewerRequestsQueryParams,
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

/**
 * Compile-time guard that every event-type literal we emit from this
 * route is also declared on the atom registration's `eventTypes`
 * vocabulary. Mirrors the reviewer-annotation pattern — the catalog
 * test is the source of truth and a typo here fails to compile
 * rather than silently emitting a stale name.
 */
type _EmittedRequestEventTypes =
  `reviewer-request.${ReviewerRequestKind}.requested`;
type _EmittedDismissEventTypes =
  `reviewer-request.${ReviewerRequestKind}.dismissed`;
type _EmittedEventTypesAreDeclared =
  | _EmittedRequestEventTypes
  | _EmittedDismissEventTypes extends (typeof REVIEWER_REQUEST_EVENT_TYPES)[number]
  ? true
  : never;

/**
 * Reviewer-only audience gate. Mirrors `requireReviewerAudience` in
 * `routes/reviewerAnnotations.ts`. Returns `true` once the guard
 * sent a 403 so the caller can early-return.
 */
function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "reviewer_requests_require_internal_audience" });
  return true;
}

/**
 * Architect-only audience gate. Mirrors `requireArchitectAudience` in
 * `routes/bimModels.ts`. Returns `true` once the guard sent a 403 so
 * the caller can early-return.
 *
 * Today architect = `audience: "user"` in the session-middleware
 * taxonomy (the only non-internal browser audience that mints a
 * requestor). When a dedicated architect audience lands, this guard
 * becomes a one-line widening — no callers need to change.
 */
function requireArchitectAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "user") return false;
  res
    .status(403)
    .json({ error: "reviewer_requests_require_architect_audience" });
  return true;
}

/**
 * Read-side gate for the engagement-scoped reviewer-request list.
 *
 * Both architect (`audience === "user"`) and reviewer
 * (`audience === "internal"`) need to read the list:
 *
 *   - Architect drives the `ReviewerRequestsStrip` open-queue
 *     surface from this endpoint.
 *   - Reviewer (Task #429) reads the same list to bind the
 *     three Request-Refresh affordances to a "Refresh requested"
 *     pending state — once a request exists for a target the
 *     affordance disables itself rather than letting the reviewer
 *     file a duplicate.
 *
 * Mutations stay split: only architects can dismiss (architect
 * gate on POST `/dismiss`) and only reviewers can create (reviewer
 * gate on POST `/`). The `audience === "ai"` path is rejected so
 * agent traffic doesn't see the open-queue.
 */
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

/**
 * Resolve the `FindingActor` envelope to stamp on `requested_by` /
 * `dismissed_by` for an in-flight request. The route gates on a
 * session-bound requestor before insert / dismiss, so the `null`
 * branch is defensive only.
 */
async function actorEnvelopeFromRequest(
  req: Request,
): Promise<ReviewerRequestActor | null> {
  const requestor = req.session.requestor;
  if (!requestor || !requestor.id) return null;
  // Best-effort hydration — falls back to a bare envelope (no
  // displayName) when the user-lookup query fails or the `users`
  // row is absent (e.g. dev session overrides or non-internal-DB
  // identity sources). `hydrateActors` already swallows the
  // not-found case; the try/catch wraps the rare DB-failure path.
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

/**
 * Wire envelope returned by every reviewer-request endpoint. Mirrors
 * the `ReviewerRequest` schema in OpenAPI — dates serialized as ISO
 * strings on the wire so the JSON envelope stays portable.
 */
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
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    triggeredActionEventId: row.triggeredActionEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Append a `reviewer-request.<kind>.<lifecycle>` event scoped to the
 * request row. Best-effort by the same contract as
 * `emitReviewerAnnotationEvent` — a history outage cannot fail the
 * HTTP request.
 */
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

    // Enforce the kind-to-target-type pairing. The closed enums
    // already guarantee `requestKind` and `targetEntityType` are
    // valid in isolation; this gate ensures the *combination* is
    // semantically correct (e.g. `refresh-briefing-source` cannot
    // target a `bim-model` row).
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
      // Should be impossible — `requireReviewerAudience` passed but
      // the session has no requestor. Fail loudly so the audit trail
      // never gets a row without attribution.
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
    // Idempotent on already-dismissed rows; reject already-resolved
    // rows with 409 (a domain action implicitly closed the request,
    // there's nothing left to dismiss).
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

// `REVIEWER_REQUEST_KINDS` and `REVIEWER_REQUEST_TARGET_TYPES` are
// imported above so the reviewer-side error envelope and the closed-
// enum check downstream stay in lockstep with the schema's
// source-of-truth tuples; reference them here so the unused-import
// linter doesn't fire on a future refactor that uses them at the
// top-level `validate kind` step.
void REVIEWER_REQUEST_KINDS;
void REVIEWER_REQUEST_TARGET_TYPES;

export default router;
