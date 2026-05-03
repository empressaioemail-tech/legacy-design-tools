/**
 * Persist + emit pair for the auto-classifier (Track 1).
 *
 * Two functions:
 *   - {@link upsertAutoClassification} — used by the live auto-trigger
 *     hook on `submission.created`. Idempotent (no-op if a row already
 *     exists). Hardcodes the `CLASSIFIER_AUTO_ACTOR` for events.
 *   - {@link emitClassificationEvents} — emits the matched pair of
 *     events for any classification write. Accepts the actor + payload
 *     as parameters so the reclassify route AND the historical-inbox
 *     backfill script can both reuse it (the backfill stamps a
 *     distinct `classifier-backfill` actor).
 *
 * Events are best-effort: a transient append failure is logged but
 * does not roll back the row insert. Rows are the source of truth;
 * events are the audit trail (locked decision #5).
 */

import { eq } from "drizzle-orm";
import {
  db as ProdDb,
  submissionClassifications,
  type SubmissionClassification,
} from "@workspace/db";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import {
  classificationAtomId,
  SUBMISSION_CLASSIFICATION_EVENT_TYPES,
} from "./atomGrammar";
import { CLASSIFIER_AUTO_ACTOR } from "./constants";
import type { ClassificationResult, ClassifierLogger } from "./types";

/**
 * Persist the auto-classifier's output. Idempotent: if a row already
 * exists for the submission, this is a no-op (the auto pass should
 * not overwrite a reviewer correction that already landed). Returns
 * the resulting row, or `null` if no write happened (existing
 * reviewer row preserved).
 *
 * Emits two events on a write:
 *   - `submission-classification.set` against the classification atom
 *   - `submission.classified` against the submission entity
 */
export async function upsertAutoClassification(
  submissionId: string,
  result: ClassificationResult,
  history: EventAnchoringService,
  reqLog: ClassifierLogger,
  dbInstance: typeof ProdDb = ProdDb,
): Promise<SubmissionClassification | null> {
  const existing = await dbInstance
    .select()
    .from(submissionClassifications)
    .where(eq(submissionClassifications.submissionId, submissionId))
    .limit(1);
  if (existing[0]) {
    reqLog.info(
      { submissionId, source: existing[0].source },
      "auto classification skipped — row already exists",
    );
    return null;
  }
  const now = new Date();
  const [row] = await dbInstance
    .insert(submissionClassifications)
    .values({
      submissionId,
      projectType: result.projectType,
      disciplines: result.disciplines,
      applicableCodeBooks: result.applicableCodeBooks,
      confidence:
        result.confidence == null ? null : String(result.confidence),
      source: "auto",
      classifiedBy: null,
      classifiedAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) {
    throw new Error("submission_classifications insert returned no row");
  }
  await emitClassificationEvents(history, {
    submissionId,
    classificationAtomId: classificationAtomId(submissionId),
    eventName: "submission.classified",
    actor: CLASSIFIER_AUTO_ACTOR,
    payload: {
      projectType: row.projectType,
      disciplines: row.disciplines,
      applicableCodeBooks: row.applicableCodeBooks,
      confidence: row.confidence == null ? null : Number(row.confidence),
      source: row.source,
    },
    reqLog,
  });
  return row;
}

/**
 * Emit the matched pair of events for a classification write:
 *   - `submission-classification.set` on the classification atom
 *   - `submission.classified` OR `submission.reclassified` on the
 *      submission entity (caller picks via `eventName`).
 *
 * Caller-supplied `actor` lets:
 *   - the live auto-trigger pass {@link CLASSIFIER_AUTO_ACTOR}
 *   - the reclassify route pass the session's reviewer requestor
 *   - the backfill script pass a distinct `classifier-backfill`
 *     system actor for deploy-log distinguishability
 */
export async function emitClassificationEvents(
  history: EventAnchoringService,
  params: {
    submissionId: string;
    classificationAtomId: string;
    eventName: "submission.classified" | "submission.reclassified";
    actor: { kind: "user" | "agent" | "system"; id: string };
    payload: Record<string, unknown>;
    reqLog: ClassifierLogger;
  },
): Promise<void> {
  try {
    await history.appendEvent({
      entityType: "submission-classification",
      entityId: params.classificationAtomId,
      eventType: SUBMISSION_CLASSIFICATION_EVENT_TYPES[0],
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    params.reqLog.error(
      { err, submissionId: params.submissionId },
      "submission-classification.set event append failed",
    );
  }
  try {
    await history.appendEvent({
      entityType: "submission",
      entityId: params.submissionId,
      eventType: params.eventName,
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    params.reqLog.error(
      { err, submissionId: params.submissionId, eventName: params.eventName },
      "submission lifecycle event append failed",
    );
  }
}
