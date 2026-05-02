/**
 * /api/submissions/:submissionId/comments — Task #431. Inline
 * reviewer↔architect conversation thread anchored to a single
 * plan-review submission.
 *
 * Two endpoints, both gated to `audience: "internal"` so the same
 * route serves both the architect-facing (design-tools) and
 * reviewer-facing (plan-review) clients without leaking comments to
 * the public unauthenticated user audience:
 *
 *   - GET  /submissions/:submissionId/comments
 *       List every comment under the submission, oldest-first
 *       (chat-transcript order).
 *
 *   - POST /submissions/:submissionId/comments
 *       Create a new comment row. The `authorRole` body field
 *       distinguishes architect vs reviewer entries; the `authorId`
 *       is server-derived from the session-bound requestor.
 *
 * Distinct from `reviewerAnnotations.ts`, which is the reviewer-only
 * scratch-note surface (Spec 307) with a promotion lifecycle. Comments
 * here are flat, cross-audience replies with no promotion concept.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  submissionComments,
  SUBMISSION_COMMENT_AUTHOR_ROLES,
  submissions,
  type SubmissionComment,
  type SubmissionCommentAuthorRole,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import {
  CreateSubmissionCommentBody,
  CreateSubmissionCommentParams,
  ListSubmissionCommentsParams,
} from "@workspace/api-zod";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { requireArchitectAudience } from "../lib/audienceGuards";

const router: IRouter = Router();

/**
 * Per-route 403 error string. The shared audience guard accepts the
 * error code as a parameter so each surface attributes its own 403
 * — `reviewer_annotations_require_internal_audience` for the
 * reviewer-only scratch-note surface, this one for the cross-audience
 * comment thread. The naming is intentionally route-prefixed so a
 * future split (architect-only audience vs reviewer-only audience)
 * is a one-line change at the call site.
 */
const SUBMISSION_COMMENTS_AUDIENCE_ERROR =
  "submission_comments_require_internal_audience";

/**
 * Wire shape returned by every comment endpoint. Mirrors the
 * `SubmissionComment` schema in the OpenAPI source — dates are
 * ISO strings on the wire so the JSON envelope stays portable.
 */
interface SubmissionCommentWire {
  id: string;
  submissionId: string;
  authorRole: SubmissionCommentAuthorRole;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

function toWire(row: SubmissionComment): SubmissionCommentWire {
  return {
    id: row.id,
    submissionId: row.submissionId,
    authorRole: row.authorRole as SubmissionCommentAuthorRole,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  "/submissions/:submissionId/comments",
  async (req: Request, res: Response): Promise<void> => {
    if (
      requireArchitectAudience(req, res, SUBMISSION_COMMENTS_AUDIENCE_ERROR)
    ) {
      return;
    }
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = ListSubmissionCommentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const rows = await db
      .select()
      .from(submissionComments)
      .where(eq(submissionComments.submissionId, sub.id))
      .orderBy(asc(submissionComments.createdAt));

    reqLog.debug(
      { submissionId: sub.id, count: rows.length },
      "listed submission comments",
    );
    res.json({ comments: rows.map(toWire) });
  },
);

router.post(
  "/submissions/:submissionId/comments",
  async (req: Request, res: Response): Promise<void> => {
    if (
      requireArchitectAudience(req, res, SUBMISSION_COMMENTS_AUDIENCE_ERROR)
    ) {
      return;
    }
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = CreateSubmissionCommentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = CreateSubmissionCommentBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }
    // Defensive enum check: the OpenAPI/Zod layer already constrains
    // the value, but pinning it against the DB-side tuple here keeps
    // a future codegen drift from inserting a row the schema CHECK
    // constraint would later reject at the DB layer.
    if (
      !(SUBMISSION_COMMENT_AUTHOR_ROLES as readonly string[]).includes(
        body.data.authorRole,
      )
    ) {
      res.status(400).json({ error: "invalid_author_role" });
      return;
    }
    const requestor = req.session.requestor;
    if (!requestor || !requestor.id) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }
    const sub = await loadSubmission(params.data.submissionId);
    if (!sub) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const inserted = await db
      .insert(submissionComments)
      .values({
        submissionId: sub.id,
        authorRole: body.data.authorRole,
        authorId: requestor.id,
        body: body.data.body,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      reqLog.error(
        { submissionId: sub.id },
        "submission-comment insert returned no row",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    reqLog.info(
      {
        submissionId: sub.id,
        commentId: row.id,
        authorRole: row.authorRole,
        authorId: row.authorId,
      },
      "submission-comment created",
    );
    res.status(201).json({ comment: toWire(row) });
  },
);

export default router;
