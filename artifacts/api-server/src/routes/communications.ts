/**
 * /api/submissions/:submissionId/communications — PLR-5.
 *
 * Two endpoints, both reviewer-only (`audience: "internal"`):
 *
 *   - GET  /submissions/:submissionId/communications
 *       Newest-first list of `submission_communications` rows for
 *       the submission. Drives the SubmissionDetailModal's
 *       "Last comment letter sent" status pill.
 *
 *   - POST /submissions/:submissionId/communications
 *       Persist a reviewer-edited comment letter, snapshot the
 *       cited findings, and append a single
 *       `communication-event.sent` history event against the new
 *       row's atom id.
 *
 * Email dispatch is intentionally out-of-scope — the api-server has
 * no outbound-mail pipeline yet (`notifications.ts` is the in-app
 * architect surface). The route logs the intended recipient list and
 * persists it for a future dispatcher to pick up.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  submissions,
  submissionCommunications,
  type SubmissionCommunication,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  CreateSubmissionCommunicationBody,
  CreateSubmissionCommunicationParams,
  ListSubmissionCommunicationsParams,
} from "@workspace/api-zod";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import { COMMUNICATION_EVENT_TYPES } from "../atoms/communication-event.atom";

const router: IRouter = Router();

const COMMUNICATIONS_AUDIENCE_ERROR =
  "communications_require_internal_audience";

interface SubmissionCommunicationWire {
  id: string;
  atomId: string;
  submissionId: string;
  subject: string;
  body: string;
  findingAtomIds: string[];
  recipientUserIds: string[];
  sentBy: { kind: "user" | "agent" | "system"; id: string; displayName?: string | null };
  sentAt: string;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toWire(row: SubmissionCommunication): SubmissionCommunicationWire {
  const sentBy = row.sentBy as unknown as SubmissionCommunicationWire["sentBy"];
  return {
    id: row.id,
    atomId: row.atomId,
    submissionId: row.submissionId,
    subject: row.subject,
    body: row.body,
    findingAtomIds: toStringArray(row.findingAtomIds),
    recipientUserIds: toStringArray(row.recipientUserIds),
    sentBy,
    sentAt: row.sentAt.toISOString(),
  };
}

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: COMMUNICATIONS_AUDIENCE_ERROR });
  return true;
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
  "/submissions/:submissionId/communications",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = ListSubmissionCommunicationsParams.safeParse(req.params);
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
      .from(submissionCommunications)
      .where(eq(submissionCommunications.submissionId, sub.id))
      .orderBy(desc(submissionCommunications.sentAt));

    reqLog.debug(
      { submissionId: sub.id, count: rows.length },
      "listed submission communications",
    );
    res.json({ communications: rows.map(toWire) });
  },
);

router.post(
  "/submissions/:submissionId/communications",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog: Logger = (req as Request & { log?: Logger }).log ?? logger;
    const params = CreateSubmissionCommunicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = CreateSubmissionCommunicationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
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

    // Allocate the row pk up-front so we can mint the atom id with
    // the prefixed grammar (`communication-event:{submissionId}:{rowId}`)
    // before the insert lands.
    const rowId = crypto.randomUUID();
    const atomId = `communication-event:${sub.id}:${rowId}`;
    const sentBy = {
      kind: requestor.kind,
      id: requestor.id,
    };

    const inserted = await db
      .insert(submissionCommunications)
      .values({
        id: rowId,
        submissionId: sub.id,
        atomId,
        subject: body.data.subject,
        body: body.data.body,
        findingAtomIds: body.data.findingAtomIds,
        recipientUserIds: body.data.recipientUserIds,
        sentBy,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      reqLog.error(
        { submissionId: sub.id },
        "submission-communication insert returned no row",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    // Append `communication-event.sent` against the new row's atom id.
    // Best-effort — a transient history outage cannot fail the send,
    // matching the surrounding finding-mutation pattern.
    try {
      await getHistoryService().appendEvent({
        entityType: "communication-event",
        entityId: atomId,
        eventType: COMMUNICATION_EVENT_TYPES[0],
        actor: sentBy,
        payload: {
          communicationId: row.id,
          submissionId: row.submissionId,
          subject: row.subject,
          recipientCount: body.data.recipientUserIds.length,
          findingCount: body.data.findingAtomIds.length,
        },
      });
    } catch (err) {
      reqLog.error(
        { err, communicationId: row.id, atomId },
        "communication-event.sent event append failed — row write kept",
      );
    }

    if (body.data.recipientUserIds.length === 0) {
      reqLog.warn(
        { submissionId: sub.id, communicationId: row.id },
        "comment letter persisted with no recipients — outbound dispatch skipped",
      );
    } else {
      reqLog.info(
        {
          submissionId: sub.id,
          communicationId: row.id,
          recipientCount: body.data.recipientUserIds.length,
          findingCount: body.data.findingAtomIds.length,
        },
        "comment letter persisted; outbound email dispatch deferred (no mail pipeline)",
      );
    }

    res.status(201).json({ communication: toWire(row) });
  },
);

export default router;
