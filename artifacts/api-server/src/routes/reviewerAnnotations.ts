/**
 * /api/submissions/:submissionId/reviewer-annotations — Wave 2 Sprint C
 * / Spec 307. Reviewer-only scratch notes anchored to a target atom
 * render inside a single submission.
 *
 * Four endpoints:
 *
 *   - GET    /submissions/:submissionId/reviewer-annotations
 *       List reviewer annotations on a submission. Optional
 *       `targetEntityType` + `targetEntityId` query filter for the
 *       single-target affordance read.
 *
 *   - POST   /submissions/:submissionId/reviewer-annotations
 *       Create a top-level annotation (or a reply if
 *       `parentAnnotationId` is supplied). Emits
 *       `reviewer-annotation.created` (top-level) or
 *       `reviewer-annotation.replied` (reply).
 *
 *   - PATCH  /submissions/:submissionId/reviewer-annotations/:annotationId
 *       Edit body / category. Promoted annotations reject all PATCHes
 *       with 409 (immutability contract).
 *
 *   - POST   /submissions/:submissionId/reviewer-annotations/promote
 *       Multi-promote. Stamps `promotedAt` on each row and emits one
 *       `reviewer-annotation.promoted` event per row that flipped.
 *       Idempotent per row.
 *
 * All four endpoints require `audience: "internal"`. Architects only
 * see annotations after promotion via the existing jurisdiction-
 * response inbox flow (no new architect-side rendering — promoted
 * annotations land in the existing inbox surface).
 *
 * Best-effort event emission via the shared `EventAnchoringService`:
 * a transient history outage cannot fail the HTTP request.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  reviewerAnnotations,
  REVIEWER_ANNOTATION_TARGET_TYPES,
  submissions,
  type ReviewerAnnotation,
  type ReviewerAnnotationTargetType,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  CreateReviewerAnnotationBody,
  CreateReviewerAnnotationParams,
  ListReviewerAnnotationsParams,
  ListReviewerAnnotationsQueryParams,
  PromoteReviewerAnnotationsBody,
  PromoteReviewerAnnotationsParams,
  UpdateReviewerAnnotationBody,
  UpdateReviewerAnnotationParams,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import {
  REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID,
  REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID,
} from "@workspace/server-actor-ids";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  REVIEWER_ANNOTATION_EVENT_TYPES,
  type ReviewerAnnotationEventType,
} from "../atoms/reviewer-annotation.atom";

const router: IRouter = Router();

const REVIEWER_ANNOTATION_CREATED_EVENT_TYPE: ReviewerAnnotationEventType =
  "reviewer-annotation.created";
const REVIEWER_ANNOTATION_REPLIED_EVENT_TYPE: ReviewerAnnotationEventType =
  "reviewer-annotation.replied";
const REVIEWER_ANNOTATION_PROMOTED_EVENT_TYPE: ReviewerAnnotationEventType =
  "reviewer-annotation.promoted";

/**
 * Compile-time guard that every event-type literal we emit from this
 * route is also declared on the atom registration's `eventTypes`
 * vocabulary. Mirrors the pattern in `engagementEvents.ts` —
 * referencing the constant tuple keeps the catalog test the source
 * of truth and a typo here fails to compile rather than silently
 * emitting a stale name.
 */
type _EmittedEventTypesAreDeclared =
  | typeof REVIEWER_ANNOTATION_CREATED_EVENT_TYPE
  | typeof REVIEWER_ANNOTATION_REPLIED_EVENT_TYPE
  | typeof REVIEWER_ANNOTATION_PROMOTED_EVENT_TYPE extends (typeof REVIEWER_ANNOTATION_EVENT_TYPES)[number]
  ? true
  : never;

/**
 * Reviewer-only audience gate. Mirrors `requireArchitectAudience` in
 * `routes/bimModels.ts`: the `sessionMiddleware` fails closed in
 * production, so an audience check here is the gate that keeps
 * reviewer scratch notes inside the reviewer-facing surface.
 *
 * Reviewer-equivalent in the existing audience taxonomy is
 * `audience: "internal"` (see `engagementEvents.ts` and
 * `bimModels.ts`); when a dedicated reviewer audience lands, this
 * guard becomes a one-line widening.
 *
 * Returns `true` once the guard sent a 403 so the caller can early-
 * return.
 */
function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "reviewer_annotations_require_internal_audience" });
  return true;
}

/**
 * Identify the reviewer making the request. The route gates on a
 * session-bound requestor before insert (the row's `reviewerId` is
 * NOT NULL), so an absent requestor on an `internal` audience
 * request 400s — that pairing should be impossible in the dev /
 * prod flows that mint sessions today, and surfacing it explicitly
 * keeps the audit trail honest rather than stamping a sentinel id.
 */
function reviewerIdFromRequest(req: Request): string | null {
  const requestor = req.session.requestor;
  if (!requestor || !requestor.id) return null;
  return requestor.id;
}

/**
 * Resolve the actor to attribute a reviewer-annotation event to.
 * Falls back to the route-level system actor when the request lacks
 * a session-bound requestor — defensive only, since the handlers all
 * gate on `reviewerIdFromRequest` before insert / promote.
 */
function actorFromRequest(
  req: Request,
  fallbackId: string,
): { kind: "user" | "agent" | "system"; id: string } {
  const requestor = req.session.requestor;
  if (requestor && requestor.id) {
    return { kind: requestor.kind, id: requestor.id };
  }
  return { kind: "system", id: fallbackId };
}

/**
 * Wire shape returned by every reviewer-annotation endpoint. Mirrors
 * the {@link ReviewerAnnotationWire} schema in the OpenAPI source —
 * dates serialized as ISO strings on the wire so the JSON envelope
 * stays portable.
 */
interface ReviewerAnnotationWire {
  id: string;
  submissionId: string;
  targetEntityType: ReviewerAnnotationTargetType;
  targetEntityId: string;
  reviewerId: string;
  body: string;
  category: string;
  parentAnnotationId: string | null;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
}

function toWire(row: ReviewerAnnotation): ReviewerAnnotationWire {
  return {
    id: row.id,
    submissionId: row.submissionId,
    targetEntityType: row.targetEntityType as ReviewerAnnotationTargetType,
    targetEntityId: row.targetEntityId,
    reviewerId: row.reviewerId,
    body: row.body,
    category: row.category,
    parentAnnotationId: row.parentAnnotationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    promotedAt: row.promotedAt ? row.promotedAt.toISOString() : null,
  };
}

/**
 * Append a `reviewer-annotation.{created,replied,promoted}` event
 * scoped to the annotation row. Best-effort by the same contract as
 * the engagementEvents helpers: a transient history outage cannot
 * fail the HTTP request.
 */
async function emitReviewerAnnotationEvent(
  history: EventAnchoringService,
  params: {
    annotation: ReviewerAnnotation;
    eventType: ReviewerAnnotationEventType;
    actor: { kind: "user" | "agent" | "system"; id: string };
    payload: Record<string, unknown>;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "reviewer-annotation",
      entityId: params.annotation.id,
      eventType: params.eventType,
      actor: params.actor,
      payload: params.payload,
    });
    reqLog.info(
      {
        annotationId: params.annotation.id,
        submissionId: params.annotation.submissionId,
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
        annotationId: params.annotation.id,
        submissionId: params.annotation.submissionId,
        eventType: params.eventType,
      },
      `${params.eventType} event append failed — row write kept`,
    );
  }
}

async function loadSubmission(submissionId: string) {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return rows[0] ?? null;
}

router.get(
  "/submissions/:submissionId/reviewer-annotations",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = ListReviewerAnnotationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const query = ListReviewerAnnotationsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query_params" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const filters = [eq(reviewerAnnotations.submissionId, sub.id)];
    if (query.data.targetEntityType) {
      filters.push(
        eq(reviewerAnnotations.targetEntityType, query.data.targetEntityType),
      );
    }
    if (query.data.targetEntityId) {
      filters.push(
        eq(reviewerAnnotations.targetEntityId, query.data.targetEntityId),
      );
    }
    const rows = await db
      .select()
      .from(reviewerAnnotations)
      .where(and(...filters))
      .orderBy(desc(reviewerAnnotations.createdAt));

    reqLog.debug(
      { submissionId: sub.id, count: rows.length },
      "listed reviewer annotations",
    );
    res.json({ annotations: rows.map(toWire) });
  },
);

router.post(
  "/submissions/:submissionId/reviewer-annotations",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = CreateReviewerAnnotationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = CreateReviewerAnnotationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const reviewerId = reviewerIdFromRequest(req);
    if (!reviewerId) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    // Spec sanity-check: targetEntityType is already constrained by
    // the OpenAPI enum, but we also validate against the DB-side
    // tuple so a future codegen drift is caught before we insert a
    // row the atom registration can't compose.
    if (
      !(REVIEWER_ANNOTATION_TARGET_TYPES as readonly string[]).includes(
        body.data.targetEntityType,
      )
    ) {
      res.status(400).json({ error: "invalid_target_entity_type" });
      return;
    }

    let parentRow: ReviewerAnnotation | null = null;
    if (body.data.parentAnnotationId) {
      const parents = await db
        .select()
        .from(reviewerAnnotations)
        .where(eq(reviewerAnnotations.id, body.data.parentAnnotationId))
        .limit(1);
      parentRow = parents[0] ?? null;
      if (!parentRow) {
        res.status(400).json({ error: "parent_annotation_not_found" });
        return;
      }
      if (parentRow.submissionId !== sub.id) {
        res
          .status(400)
          .json({ error: "parent_annotation_submission_mismatch" });
        return;
      }
      if (parentRow.parentAnnotationId !== null) {
        // Single-level threading is the v1 contract — replies cannot
        // reply to replies. The DB column itself accepts any
        // annotation id under the same submission so a future deep-
        // threading relax is a route-only change.
        res
          .status(400)
          .json({ error: "parent_annotation_must_be_top_level" });
        return;
      }
    }

    const inserted = await db
      .insert(reviewerAnnotations)
      .values({
        submissionId: sub.id,
        targetEntityType: body.data.targetEntityType,
        targetEntityId: body.data.targetEntityId,
        reviewerId,
        body: body.data.body,
        category: body.data.category ?? "note",
        parentAnnotationId: body.data.parentAnnotationId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      reqLog.error(
        { submissionId: sub.id },
        "reviewer-annotation insert returned no row",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    const history = getHistoryService();
    const eventType = parentRow
      ? REVIEWER_ANNOTATION_REPLIED_EVENT_TYPE
      : REVIEWER_ANNOTATION_CREATED_EVENT_TYPE;
    await emitReviewerAnnotationEvent(
      history,
      {
        annotation: row,
        eventType,
        actor: actorFromRequest(req, REVIEWER_ANNOTATION_AUTHOR_ACTOR_ID),
        payload: {
          submissionId: row.submissionId,
          targetEntityType: row.targetEntityType,
          targetEntityId: row.targetEntityId,
          category: row.category,
          parentAnnotationId: row.parentAnnotationId,
        },
      },
      reqLog,
    );

    res.status(201).json({ annotation: toWire(row) });
  },
);

router.patch(
  "/submissions/:submissionId/reviewer-annotations/:annotationId",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = UpdateReviewerAnnotationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = UpdateReviewerAnnotationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }

    const existing = await db
      .select()
      .from(reviewerAnnotations)
      .where(
        and(
          eq(reviewerAnnotations.id, params.data.annotationId),
          eq(reviewerAnnotations.submissionId, params.data.submissionId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "annotation_not_found" });
      return;
    }
    if (row.promotedAt !== null) {
      res
        .status(409)
        .json({ error: "annotation_promoted_immutable" });
      return;
    }

    // Empty body → no-op. Returning the unchanged row keeps the
    // contract symmetric with the patch-no-op behaviour in
    // engagements.ts (PATCH /engagements/:id with an empty body
    // returns the unchanged row rather than 400).
    const hasBody = typeof body.data.body === "string";
    const hasCategory = typeof body.data.category === "string";
    if (!hasBody && !hasCategory) {
      res.json({ annotation: toWire(row) });
      return;
    }

    const updated = await db
      .update(reviewerAnnotations)
      .set({
        ...(hasBody ? { body: body.data.body } : {}),
        ...(hasCategory ? { category: body.data.category } : {}),
        updatedAt: new Date(),
      })
      .where(eq(reviewerAnnotations.id, row.id))
      .returning();
    const updatedRow = updated[0] ?? row;
    reqLog.debug(
      { annotationId: row.id, submissionId: row.submissionId },
      "reviewer-annotation updated",
    );
    res.json({ annotation: toWire(updatedRow) });
  },
);

router.post(
  "/submissions/:submissionId/reviewer-annotations/promote",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = PromoteReviewerAnnotationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = PromoteReviewerAnnotationsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    // De-dup the request body's id list so a caller passing the same
    // id twice doesn't fan out to two updates / events for the same
    // row.
    const requestedIds = Array.from(new Set(body.data.annotationIds));

    const existing =
      requestedIds.length > 0
        ? await db
            .select()
            .from(reviewerAnnotations)
            .where(
              and(
                eq(reviewerAnnotations.submissionId, sub.id),
                inArray(reviewerAnnotations.id, requestedIds),
              ),
            )
        : [];

    const knownIds = new Set(existing.map((r) => r.id));
    const unknown = requestedIds.filter((id) => !knownIds.has(id));
    const alreadyPromoted = existing.filter((r) => r.promotedAt !== null);
    const toPromote = existing.filter((r) => r.promotedAt === null);

    let promoted: ReviewerAnnotation[] = [];
    if (toPromote.length > 0) {
      const now = new Date();
      promoted = await db
        .update(reviewerAnnotations)
        .set({ promotedAt: now, updatedAt: now })
        .where(
          and(
            eq(reviewerAnnotations.submissionId, sub.id),
            inArray(
              reviewerAnnotations.id,
              toPromote.map((r) => r.id),
            ),
            // Belt-and-suspenders concurrent-promote guard: only flip
            // rows that are still un-promoted at update time so a
            // concurrent promote call can't double-emit the event.
            isNull(reviewerAnnotations.promotedAt),
          ),
        )
        .returning();

      const history = getHistoryService();
      const actor = actorFromRequest(req, REVIEWER_ANNOTATION_PROMOTE_ACTOR_ID);
      await Promise.all(
        promoted.map((row) =>
          emitReviewerAnnotationEvent(
            history,
            {
              annotation: row,
              eventType: REVIEWER_ANNOTATION_PROMOTED_EVENT_TYPE,
              actor,
              payload: {
                submissionId: row.submissionId,
                targetEntityType: row.targetEntityType,
                targetEntityId: row.targetEntityId,
                category: row.category,
                parentAnnotationId: row.parentAnnotationId,
                promotedAt: row.promotedAt
                  ? row.promotedAt.toISOString()
                  : null,
              },
            },
            reqLog,
          ),
        ),
      );
    }

    reqLog.info(
      {
        submissionId: sub.id,
        promotedCount: promoted.length,
        alreadyPromotedCount: alreadyPromoted.length,
        unknownCount: unknown.length,
      },
      "reviewer-annotation promote completed",
    );

    res.json({
      promoted: promoted.map(toWire),
      alreadyPromoted: alreadyPromoted.map(toWire),
      unknown,
    });
  },
);

export default router;
