/**
 * Plan-set piece gather + classification persistence (WS1).
 *
 * Loads the latest snapshot's sheets and engagement attached documents
 * for a submission, classifies each piece by discipline, and upserts
 * rows into `plan_set_piece_classifications`.
 */

import { desc, eq } from "drizzle-orm";
import {
  db,
  attachedDocuments,
  planSetPieceClassifications,
  sheets,
  snapshots,
  submissions,
} from "@workspace/db";
import {
  classifyPlanSetPieces,
  type PlanSetPieceCandidate,
} from "@workspace/finding-engine";
import { logger } from "./logger";

/** Gather sheet + attached-document candidates for classification. */
export async function gatherPlanSetPieceCandidates(
  submissionId: string,
): Promise<PlanSetPieceCandidate[]> {
  const subRows = await db
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return [];

  const snapRows = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.engagementId, sub.engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  const snap = snapRows[0];

  const candidates: PlanSetPieceCandidate[] = [];

  if (snap) {
    const sheetRows = await db
      .select({
        id: sheets.id,
        sheetNumber: sheets.sheetNumber,
        sheetName: sheets.sheetName,
        contentBody: sheets.contentBody,
      })
      .from(sheets)
      .where(eq(sheets.snapshotId, snap.id))
      .orderBy(sheets.sortOrder);
    for (const row of sheetRows) {
      candidates.push({
        pieceId: row.id,
        kind: "sheet",
        label: `${row.sheetNumber} — ${row.sheetName}`,
        text: row.contentBody,
        sheetNumber: row.sheetNumber,
      });
    }
  }

  const docRows = await db
    .select({
      id: attachedDocuments.id,
      title: attachedDocuments.title,
      documentType: attachedDocuments.documentType,
      extractedText: attachedDocuments.extractedText,
    })
    .from(attachedDocuments)
    .where(eq(attachedDocuments.engagementId, sub.engagementId));

  for (const row of docRows) {
    candidates.push({
      pieceId: row.id,
      kind: "attached-document",
      label: row.title,
      text: row.extractedText?.trim().length ? row.extractedText : null,
      documentType: row.documentType,
    });
  }

  return candidates;
}

/** Keep candidates whose pieceId (or PDF page expansion) matches the selection. */
export function filterPlanSetPieceCandidates(
  candidates: PlanSetPieceCandidate[],
  selectedPieceIds?: ReadonlyArray<string> | null,
): PlanSetPieceCandidate[] {
  if (!selectedPieceIds?.length) return candidates;
  const selected = new Set(selectedPieceIds);
  return candidates.filter((c) => {
    if (selected.has(c.pieceId)) return true;
    for (const id of selectedPieceIds) {
      if (c.pieceId.startsWith(`${id}:page`)) return true;
    }
    return false;
  });
}

/** Classify and persist all plan-set pieces for a submission. */
export async function classifyAndPersistPlanSetPieces(
  submissionId: string,
  reqLog: typeof logger = logger,
): Promise<PlanSetPieceCandidate[]> {
  const candidates = await gatherPlanSetPieceCandidates(submissionId);
  if (candidates.length === 0) return [];

  const classifications = classifyPlanSetPieces(candidates);
  for (const c of classifications) {
    try {
      await db
        .insert(planSetPieceClassifications)
        .values({
          submissionId,
          pieceKind: c.kind,
          pieceId: c.pieceId,
          discipline: c.discipline,
          confidence: String(c.confidence),
          source: c.source,
        })
        .onConflictDoUpdate({
          target: [
            planSetPieceClassifications.pieceKind,
            planSetPieceClassifications.pieceId,
          ],
          set: {
            submissionId,
            discipline: c.discipline,
            confidence: String(c.confidence),
            source: c.source,
            classifiedAt: new Date(),
          },
        });
    } catch (err) {
      reqLog.warn(
        { err, submissionId, pieceId: c.pieceId },
        "plan-set classification upsert failed — continuing",
      );
    }
  }

  reqLog.info(
    {
      submissionId,
      pieceCount: candidates.length,
      disciplineCount: classifications.length,
    },
    "plan-set classification persisted",
  );

  return candidates;
}
