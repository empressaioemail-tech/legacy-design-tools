/**
 * PLR-6 / Task #460 — `/submissions/:submissionId/decisions` surface.
 *
 * Reviewer-only Decide route: records a verdict (`approve`,
 * `approve_with_conditions`, `return_for_revision`) against a
 * plan-review submission. Each verdict is persisted as one
 * `decision-event.recorded` row on the `decision-event` atom's chain
 * (one event per decision; entityId is a freshly-minted UUID),
 * additionally updating the parent submission's `status` /
 * `reviewerComment` columns and emitting a companion
 * `submission.status-changed` event so the per-submission status
 * timeline reflects the new state.
 *
 * Verdict → submission-status mapping:
 *   - `approve`                  → `approved`
 *   - `approve_with_conditions`  → `approved` (the verdict carries the
 *     "with conditions" fact in the decision-event payload; the
 *     `submission.status` enum stays at the canonical four values)
 *   - `return_for_revision`      → `corrections_requested`
 *
 * GET returns every decision recorded for a submission, newest-first.
 *
 * Audience: both endpoints require `audience: "internal"` (the
 * reviewer-facing audience). Architects hitting these routes get a
 * 403; the Decide UI is reviewer-only.
 *
 * Coexistence with the legacy `/engagements/:id/submissions/:sid/response`
 * endpoint (Task #428's DecisionTab): both paths can co-exist on the
 * same submission. Each appends its own audit event; the latest call
 * wins for the row's `status` / `reviewerComment` columns.
 */

import { randomUUID } from "node:crypto";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  and,
  desc,
  eq,
  sql,
} from "drizzle-orm";
import {
  atomEvents,
  db,
  submissions,
  type SubmissionStatus,
} from "@workspace/db";
import {
  ListSubmissionDecisionsParams,
  RecordDecisionBody,
  RecordDecisionParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import { requireArchitectAudience } from "../lib/audienceGuards";
import {
  DECISION_RECORDED_ACTOR,
  emitDecisionEventRecordedEvent,
  emitSubmissionStatusChangedEvent,
  type EngagementEventActor,
} from "../lib/engagementEvents";
import {
  DECISION_VERDICT_VALUES,
  type DecisionVerdict,
  type DecisionWire,
} from "../atoms/decision-event.atom";

/**
 * Wire string the audience guard uses for its 403 payload. Mirrors
 * the per-route convention used by the reviewer-annotation /
 * bim-model surfaces.
 */
const DECISIONS_AUDIENCE_ERROR = "decisions_require_internal_audience";

const router: IRouter = Router();

/** Verdict → submission `status` mapping, per route doc-block. */
const VERDICT_TO_STATUS: Record<DecisionVerdict, SubmissionStatus> = {
  approve: "approved",
  approve_with_conditions: "approved",
  return_for_revision: "corrections_requested",
};

router.post(
  "/submissions/:submissionId/decisions",
  async (req: Request, res: Response): Promise<void> => {
    if (requireArchitectAudience(req, res, DECISIONS_AUDIENCE_ERROR)) {
      return;
    }
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    const params = RecordDecisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }
    const body = RecordDecisionBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_request_body" });
      return;
    }

    // Defensive runtime check — the OpenAPI enum is the authoritative
    // gate, but we guard the verdict tuple here too so a stale codegen
    // can't slip an unknown value past the status mapping below.
    const verdict = body.data.verdict as DecisionVerdict;
    if (!(DECISION_VERDICT_VALUES as readonly string[]).includes(verdict)) {
      res.status(400).json({ error: "invalid_verdict" });
      return;
    }

    const rawComment = body.data.comment;
    const comment =
      typeof rawComment === "string" && rawComment.trim().length > 0
        ? rawComment.trim()
        : null;

    const existingRows = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, params.data.submissionId))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const targetStatus = VERDICT_TO_STATUS[verdict];
    const now = new Date();

    const [updated] = await db
      .update(submissions)
      .set({
        status: targetStatus,
        // Persist the comment alongside the row so the existing list
        // surfaces (`GET /engagements/:id/submissions`) reflect it
        // without a follow-up decisions read.
        reviewerComment: comment,
        respondedAt: now,
        responseRecordedAt: now,
      })
      .where(eq(submissions.id, existing.id))
      .returning();
    if (!updated) {
      throw new Error("submission update returned no row");
    }

    // Attribute the verdict to the session-bound reviewer when one is
    // attached; the audience guard above ensures we're on the
    // internal-audience path so this is the typical case. Falls back
    // to the dedicated `decision-recorded` system actor when missing.
    const requestor = req.session?.requestor;
    const actor: EngagementEventActor =
      requestor && requestor.id
        ? { kind: requestor.kind, id: requestor.id }
        : DECISION_RECORDED_ACTOR;

    const decisionId = randomUUID();
    const history = getHistoryService();
    const recorded = await emitDecisionEventRecordedEvent(
      history,
      {
        decisionId,
        submissionId: updated.id,
        engagementId: updated.engagementId,
        verdict,
        comment,
        actor,
      },
      reqLog,
    );

    // Companion `submission.status-changed` event whenever the verdict
    // moved the row's status. Skipped on no-op transitions to keep
    // the per-submission status timeline focused on real state moves;
    // the canonical decision-event chain still preserves the
    // re-record for audit purposes.
    const fromStatus = existing.status as SubmissionStatus;
    if (fromStatus !== targetStatus) {
      await emitSubmissionStatusChangedEvent(
        history,
        {
          submissionId: updated.id,
          engagementId: updated.engagementId,
          fromStatus,
          toStatus: targetStatus,
          note: comment,
          occurredAt: now,
          actor,
        },
        reqLog,
      );
    }

    const decision: DecisionWire = {
      id: decisionId,
      submissionId: updated.id,
      verdict,
      comment,
      recordedAt: (recorded?.occurredAt ?? now).toISOString(),
      recordedBy: { kind: actor.kind, id: actor.id },
    };
    res.status(201).json(decision);
  },
);

router.get(
  "/submissions/:submissionId/decisions",
  async (req: Request, res: Response): Promise<void> => {
    if (requireArchitectAudience(req, res, DECISIONS_AUDIENCE_ERROR)) {
      return;
    }
    const params = ListSubmissionDecisionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_path_params" });
      return;
    }

    const subRows = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, params.data.submissionId))
      .limit(1);
    if (!subRows[0]) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }

    const rows = await db
      .select({
        id: atomEvents.id,
        entityId: atomEvents.entityId,
        actor: atomEvents.actor,
        payload: atomEvents.payload,
        occurredAt: atomEvents.occurredAt,
      })
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "decision-event"),
          eq(atomEvents.eventType, "decision-event.recorded"),
          sql`${atomEvents.payload}->>'submissionId' = ${params.data.submissionId}`,
        ),
      )
      .orderBy(desc(atomEvents.occurredAt));

    const items: DecisionWire[] = rows.map((r) => {
      const payload = r.payload as Record<string, unknown>;
      const verdictRaw = payload["verdict"];
      const verdict: DecisionVerdict = (
        DECISION_VERDICT_VALUES as readonly string[]
      ).includes(verdictRaw as string)
        ? (verdictRaw as DecisionVerdict)
        : "approve";
      const commentRaw = payload["comment"];
      const comment =
        typeof commentRaw === "string" && commentRaw.length > 0
          ? commentRaw
          : null;
      const actor = r.actor as { kind: string; id: string };
      return {
        id: r.entityId,
        submissionId: params.data.submissionId,
        verdict,
        comment,
        recordedAt: r.occurredAt.toISOString(),
        recordedBy: {
          kind: actor.kind as "user" | "agent" | "system",
          id: actor.id,
        },
      };
    });

    res.json({ items });
  },
);

export default router;
