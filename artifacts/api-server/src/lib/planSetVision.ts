/**
 * Gather per-page PNG images from PDF attached documents for P2 vision read.
 */

import { eq } from "drizzle-orm";
import { db, attachedDocuments } from "@workspace/db";
import type { AttachedSheetImage } from "@workspace/finding-engine";
import { ObjectStorageService } from "./objectStorage";
import { renderPdfPagesToPng, PDF_RENDER_MAX_PAGES } from "./pdfPageRenderer";

export interface PlanSetVisionImageMap {
  /** pieceId (attached-document id) → page images */
  byDocumentId: Map<string, AttachedSheetImage[]>;
  /** Flat list for GenerateFindingsInput.attachedSheetImages */
  allImages: AttachedSheetImage[];
}

/**
 * Render PDF attached documents for an engagement into per-page PNGs.
 * Each page becomes a synthetic piece image keyed by `docId:pageN`.
 */
export async function gatherPlanSetVisionImages(
  engagementId: string,
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<PlanSetVisionImageMap> {
  const docs = await db
    .select({
      id: attachedDocuments.id,
      title: attachedDocuments.title,
      originalBlobRef: attachedDocuments.originalBlobRef,
    })
    .from(attachedDocuments)
    .where(eq(attachedDocuments.engagementId, engagementId));

  const storage = new ObjectStorageService();
  const byDocumentId = new Map<string, AttachedSheetImage[]>();
  const allImages: AttachedSheetImage[] = [];

  for (const doc of docs) {
    let bytes: Buffer;
    try {
      bytes = await storage.getObjectEntityBytes(doc.originalBlobRef);
    } catch {
      log?.("plan-set vision: blob fetch failed", { docId: doc.id });
      continue;
    }
    if (bytes.length < 5 || bytes.subarray(0, 4).toString() !== "%PDF") {
      continue;
    }

    const pages = await renderPdfPagesToPng(bytes, {
      maxPages: PDF_RENDER_MAX_PAGES,
    });
    const docImages: AttachedSheetImage[] = [];
    for (const page of pages) {
      const pieceId = `${doc.id}:page${page.pageIndex + 1}`;
      const img: AttachedSheetImage = {
        pieceId,
        pngBase64: page.png.toString("base64"),
        label: `${doc.title} — page ${page.pageIndex + 1}`,
      };
      docImages.push(img);
      allImages.push(img);
    }
    if (docImages.length > 0) {
      byDocumentId.set(doc.id, docImages);
      log?.("plan-set vision: rendered PDF pages", {
        docId: doc.id,
        pageCount: docImages.length,
      });
    }
  }

  return { byDocumentId, allImages };
}

/**
 * Expand attached-document piece candidates with per-page synthetic pieceIds
 * so vision images route to the correct discipline pass.
 */
export function expandCandidatesWithPdfPages(
  candidates: Array<{
    pieceId: string;
    kind: "sheet" | "attached-document";
    label: string;
    text: string | null;
    sheetNumber?: string | null;
    documentType?: string | null;
  }>,
  imageMap: PlanSetVisionImageMap,
): typeof candidates {
  const expanded = [...candidates];
  for (const c of candidates) {
    if (c.kind !== "attached-document") continue;
    const pages = imageMap.byDocumentId.get(c.pieceId);
    if (!pages || pages.length === 0) continue;
    for (const page of pages) {
      expanded.push({
        pieceId: page.pieceId,
        kind: "attached-document",
        label: page.label ?? c.label,
        text: c.text,
        documentType: c.documentType,
      });
    }
  }
  return expanded;
}
