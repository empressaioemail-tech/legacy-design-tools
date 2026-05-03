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
 * Coexistence with the (now-retired) `/engagements/:id/submissions/:sid/response`
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
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  atomEvents,
  db,
  decisionPdfArtifacts,
  permitCounters,
  sheets,
  snapshots,
  submissions,
  users,
  type SubmissionStatus,
} from "@workspace/db";
import {
  renderStampedPlanSet,
  type StampPlanSheet,
} from "@workspace/plan-review-pdf";
import { ObjectStorageService } from "../lib/objectStorage";
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

/** V1 tenant display name printed on the issued-PDF stamp seal. */
const ISSUED_PDF_TENANT_NAME = "City of Empressa";

/** Tenant id used by the V1 single-tenant permit counter. */
const PERMIT_TENANT_ID = "empressa";

/**
 * Atomically allocate the next `EMP-{YYYY}-{seq}` permit number.
 * Uses an upsert with `RETURNING last_issued_seq`, so concurrent
 * approvals serialize on the row lock and never collide.
 */
async function allocatePermitNumber(approvalDate: Date): Promise<string> {
  const year = approvalDate.getUTCFullYear();
  const result = await db
    .insert(permitCounters)
    .values({ tenantId: PERMIT_TENANT_ID, year, lastIssuedSeq: 1 })
    .onConflictDoUpdate({
      target: [permitCounters.tenantId, permitCounters.year],
      set: { lastIssuedSeq: sql`${permitCounters.lastIssuedSeq} + 1` },
    })
    .returning({ seq: permitCounters.lastIssuedSeq });
  const seq = result[0]?.seq ?? 1;
  return `EMP-${year}-${String(seq).padStart(4, "0")}`;
}

/** Resolve approver display name from the users table; falls back to actor id. */
async function loadApproverDisplayName(
  actor: EngagementEventActor,
): Promise<string> {
  if (actor.kind !== "user") return "Reviewer (system)";
  const rows = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);
  return rows[0]?.displayName ?? `Reviewer ${actor.id.slice(0, 8)}`;
}

/**
 * Resolve the submission's contemporaneous sheet set (PNG bytes
 * included) so the stamper can render every sheet. Mirrors the
 * resolver in `routes/sheets.ts` GET /submissions/:submissionId/sheets
 * — newest snapshot at-or-before `submittedAt`, falling back to the
 * engagement's earliest snapshot for legacy rows.
 */
async function loadSubmissionSheetsForStamp(
  submissionId: string,
): Promise<StampPlanSheet[]> {
  const subRows = await db
    .select({
      id: submissions.id,
      engagementId: submissions.engagementId,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return [];

  let snapRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.engagementId, sub.engagementId),
        lte(snapshots.receivedAt, sub.submittedAt),
      ),
    )
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  if (snapRows.length === 0) {
    snapRows = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.engagementId, sub.engagementId))
      .orderBy(asc(snapshots.receivedAt))
      .limit(1);
  }
  const snap = snapRows[0];
  if (!snap) return [];

  const rows = await db
    .select({
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      fullPng: sheets.fullPng,
      fullWidth: sheets.fullWidth,
      fullHeight: sheets.fullHeight,
    })
    .from(sheets)
    .where(eq(sheets.snapshotId, snap.id))
    .orderBy(asc(sheets.sortOrder));

  return rows.map((r) => ({
    sheetNumber: r.sheetNumber,
    sheetName: r.sheetName,
    fullPng: Buffer.isBuffer(r.fullPng)
      ? new Uint8Array(r.fullPng)
      : (r.fullPng as Uint8Array),
    fullWidth: r.fullWidth,
    fullHeight: r.fullHeight,
  }));
}

let cachedObjectStorage: ObjectStorageService | null = null;
function getObjectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

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

    // Append the recorded event first; the PDF render is derived
    // state and uses the event's canonical `occurredAt` as its
    // approval date so the stamp + side-table row + audit chain all
    // agree on a single timestamp.
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
    const approvalDate = recorded?.occurredAt ?? now;

    let pdfArtifactRef: string | null = null;
    let permitNumber: string | null = null;
    let approverName: string | null = null;
    if (verdict === "approve" || verdict === "approve_with_conditions") {
      try {
        const sheetSet = await loadSubmissionSheetsForStamp(updated.id);
        permitNumber = await allocatePermitNumber(approvalDate);
        approverName = await loadApproverDisplayName(actor);
        const { bytes } = await renderStampedPlanSet({
          tenantName: ISSUED_PDF_TENANT_NAME,
          submissionId: updated.id,
          sheets: sheetSet,
          decisionEvent: {
            permitNumber,
            verdict,
            approvalDate,
            approverName,
            comment,
          },
        });
        pdfArtifactRef = await getObjectStorage()
          .uploadObjectEntityFromBuffer(Buffer.from(bytes), "application/pdf");
        await db.insert(decisionPdfArtifacts).values({
          decisionId,
          submissionId: updated.id,
          pdfArtifactRef,
          permitNumber,
          approverName,
          approvalDate,
        });
        reqLog.info(
          { decisionId, submissionId: updated.id, pdfArtifactRef, permitNumber, sheetCount: sheetSet.length },
          "issued plan-set PDF rendered",
        );
      } catch (err) {
        pdfArtifactRef = null;
        permitNumber = null;
        approverName = null;
        reqLog.error(
          { err, decisionId, submissionId: updated.id, verdict },
          "issued plan-set PDF render/upload failed — verdict kept",
        );
      }
    }

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
      pdfArtifactRef,
      permitNumber,
    };
    res.status(201).json(decision);
  },
);

/**
 * PLR-11 — `GET /submissions/:submissionId/issued-pdf`. Streams the
 * city-seal-stamped issued plan-set PDF rendered by the most recent
 * approve / approve_with_conditions verdict. 404 when no approve
 * verdict has been recorded for the submission yet (the FE hides
 * the download link in that state).
 *
 * Reviewer-only — same audience guard as the rest of this route.
 * Future work could expose an architect-facing variant gated on the
 * recipient list.
 */
router.get(
  "/submissions/:submissionId/issued-pdf",
  async (req: Request, res: Response): Promise<void> => {
    if (requireArchitectAudience(req, res, DECISIONS_AUDIENCE_ERROR)) {
      return;
    }
    const submissionId = String(req.params["submissionId"] ?? "");
    if (!submissionId) {
      res.status(400).json({ error: "missing_submission_id" });
      return;
    }
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    // Newest artifact wins (re-approves overwrite older renders).
    const rows = await db
      .select({ pdfArtifactRef: decisionPdfArtifacts.pdfArtifactRef })
      .from(decisionPdfArtifacts)
      .where(eq(decisionPdfArtifacts.submissionId, submissionId))
      .orderBy(desc(decisionPdfArtifacts.renderedAt))
      .limit(1);
    const objectPath = rows[0]?.pdfArtifactRef ?? "";
    if (!objectPath) {
      res.status(404).json({ error: "issued_pdf_not_found" });
      return;
    }

    try {
      const bytes = await getObjectStorage().getObjectEntityBytes(objectPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="issued-plan-set-${submissionId}.pdf"`,
      );
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(bytes);
    } catch (err) {
      reqLog.error(
        { err, submissionId, objectPath },
        "issued PDF object fetch failed",
      );
      res.status(404).json({ error: "issued_pdf_not_found" });
    }
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
        pdfArtifactRef: decisionPdfArtifacts.pdfArtifactRef,
        permitNumber: decisionPdfArtifacts.permitNumber,
      })
      .from(atomEvents)
      .leftJoin(
        decisionPdfArtifacts,
        sql`${decisionPdfArtifacts.decisionId}::text = ${atomEvents.entityId}`,
      )
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
        pdfArtifactRef: r.pdfArtifactRef ?? null,
        permitNumber: r.permitNumber ?? null,
      };
    });

    res.json({ items });
  },
);

export default router;
