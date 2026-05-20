/**
 * L2 — `sheet-content-extraction` + `attached-document` endpoints
 * (Cortex Lane C.4 / C.4.2).
 *
 *   POST /api/sheets/:sheetId/content-extraction          trigger + emit
 *   GET  /api/sheets/:sheetId/content-extraction          fetch (or null)
 *   GET  /api/engagements/:engagementId/attached-documents list
 *   GET  /api/attached-documents/:attachedDocumentId      fetch
 *
 * All routes are gated by {@link requireServiceTokenOrSession} (the
 * hauska-mcp-server bearer path + the Cortex SPA browser-session path).
 * Responses are full atom instances conforming to
 * `SHEET_CONTENT_EXTRACTION_SCHEMA` / `ATTACHED_DOCUMENT_SCHEMA`
 * (`@workspace/atoms-l-surface`).
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L2.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  sheets,
  engagements,
  sheetContentExtractions,
  attachedDocuments,
  type SheetContentExtraction,
  type AttachedDocument,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import {
  type SheetContentExtractionAtomInstance,
  type AttachedDocumentAtomInstance,
  type SheetTextSegment,
  type SheetStructuredAnnotation,
  type AttachedDocumentType,
} from "@workspace/atoms-l-surface";
import { logger } from "../lib/logger";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { L_SURFACE_SOURCE_ADAPTER, contentHashOf } from "../lib/lSurfaceAtom";
import {
  UUID_RE,
  resolveTenantId,
  resolveEventActor,
  recordLSurfaceEvent,
} from "../lib/lSurfaceRoute";
import {
  extractSheetContentBody,
  SHEET_CONTENT_ANTHROPIC_MODEL,
} from "../lib/sheetContentExtractor";
import { buildTextSegments, parseDocumentTypeFilter } from "./sheetContent.logic";

const router: IRouter = Router();

router.use(requireServiceTokenOrSession);

/** Materialize an L2a `sheet-content-extraction` atom from its row. */
function toSheetContentExtractionAtom(
  row: SheetContentExtraction,
  tenantId: string,
): SheetContentExtractionAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    sourceSheetId: row.sourceSheetId,
    engagementId: row.engagementId,
    pageLabel: row.pageLabel,
    extractedTextSegments: (row.extractedTextSegments ??
      []) as SheetTextSegment[],
    structuredAnnotations: (row.structuredAnnotations ??
      []) as SheetStructuredAnnotation[],
    ocrModel: row.ocrModel,
    actorId: row.actorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "sheet-content-extraction",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

/** Materialize an L2b `attached-document` atom from its row. */
function toAttachedDocumentAtom(
  row: AttachedDocument,
  tenantId: string,
): AttachedDocumentAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    engagementId: row.engagementId,
    title: row.title,
    documentType: row.documentType as AttachedDocumentType,
    extractedText: row.extractedText,
    originalBlobRef: row.originalBlobRef,
    actorId: row.actorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "attached-document",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

/* -------------------------------------------------------------------------- */
/*       POST /api/sheets/:sheetId/content-extraction  — trigger + emit        */
/* -------------------------------------------------------------------------- */

router.post(
  "/sheets/:sheetId/content-extraction",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const sheetId =
      typeof req.params.sheetId === "string" ? req.params.sheetId : "";

    if (!UUID_RE.test(sheetId)) {
      res.status(404).json({ error: "sheet_not_found" });
      return;
    }

    try {
      const sheetRows = await db
        .select({
          id: sheets.id,
          engagementId: sheets.engagementId,
          sheetNumber: sheets.sheetNumber,
          contentBody: sheets.contentBody,
          fullPng: sheets.fullPng,
        })
        .from(sheets)
        .where(eq(sheets.id, sheetId))
        .limit(1);
      const sheet = sheetRows[0];
      if (!sheet) {
        res.status(404).json({ error: "sheet_not_found" });
        return;
      }

      // Prefer the OCR body the sheet-ingest vision pass already
      // captured (`sheets.content_body`); fall back to a synchronous
      // vision pass when it is absent. The pass no-ops in mock mode.
      let ocrBody = sheet.contentBody ?? "";
      if (ocrBody.trim().length === 0) {
        const outcome = await extractSheetContentBody(sheet.fullPng);
        if (outcome.kind === "text") {
          ocrBody = outcome.body;
          // Backfill the sheet row so the cross-reference surfaces
          // pick it up too.
          await db
            .update(sheets)
            .set({ contentBody: ocrBody })
            .where(eq(sheets.id, sheetId));
        }
      }

      const ocrModel =
        ocrBody.trim().length > 0 ? SHEET_CONTENT_ANTHROPIC_MODEL : "mock";
      const now = new Date();

      const [row] = await db
        .insert(sheetContentExtractions)
        .values({
          sourceSheetId: sheetId,
          engagementId: sheet.engagementId,
          pageLabel: sheet.sheetNumber,
          extractedTextSegments: buildTextSegments(ocrBody),
          structuredAnnotations: [],
          ocrModel,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sheetContentExtractions.sourceSheetId,
          set: {
            engagementId: sheet.engagementId,
            pageLabel: sheet.sheetNumber,
            extractedTextSegments: buildTextSegments(ocrBody),
            structuredAnnotations: [],
            ocrModel,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) throw new Error("sheet_content_extractions upsert returned no row");

      const atom = toSheetContentExtractionAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "sheet-content-extraction",
        entityId: row.id,
        eventType: "sheet-content-extraction.extracted",
        actor: resolveEventActor(req),
        payload: {
          sourceSheetId: sheetId,
          segmentCount: atom.extractedTextSegments.length,
          ocrModel,
        },
      });

      res.json({ sheetContentExtraction: atom });
    } catch (err) {
      reqLog.error({ err, sheetId }, "sheet content-extraction failed");
      res.status(500).json({ error: "Failed to run content extraction" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/sheets/:sheetId/content-extraction  — fetch (or null)        */
/* -------------------------------------------------------------------------- */

router.get(
  "/sheets/:sheetId/content-extraction",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const sheetId =
      typeof req.params.sheetId === "string" ? req.params.sheetId : "";

    if (!UUID_RE.test(sheetId)) {
      res.status(404).json({ error: "sheet_not_found" });
      return;
    }

    try {
      const sheetRows = await db
        .select({ id: sheets.id })
        .from(sheets)
        .where(eq(sheets.id, sheetId))
        .limit(1);
      if (!sheetRows[0]) {
        res.status(404).json({ error: "sheet_not_found" });
        return;
      }

      const rows = await db
        .select()
        .from(sheetContentExtractions)
        .where(eq(sheetContentExtractions.sourceSheetId, sheetId))
        .limit(1);
      const row = rows[0];
      // A sheet that exists but has not been extracted is a normal
      // empty result — `null`, not a 404.
      res.json({
        sheetContentExtraction: row
          ? toSheetContentExtractionAtom(row, resolveTenantId(req))
          : null,
      });
    } catch (err) {
      reqLog.error({ err, sheetId }, "fetch sheet content-extraction failed");
      res.status(500).json({ error: "Failed to fetch content extraction" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*    GET /api/engagements/:engagementId/attached-documents  — list            */
/* -------------------------------------------------------------------------- */

router.get(
  "/engagements/:engagementId/attached-documents",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const filter = parseDocumentTypeFilter(req.query.documentType);
    if (!filter.ok) {
      res.status(400).json({ error: filter.error });
      return;
    }

    try {
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const where =
        filter.value === null
          ? eq(attachedDocuments.engagementId, engagementId)
          : and(
              eq(attachedDocuments.engagementId, engagementId),
              eq(attachedDocuments.documentType, filter.value),
            );

      const rows = await db
        .select()
        .from(attachedDocuments)
        .where(where)
        .orderBy(asc(attachedDocuments.title));

      const tenantId = resolveTenantId(req);
      res.json({
        attachedDocuments: rows.map((r) => toAttachedDocumentAtom(r, tenantId)),
      });
    } catch (err) {
      reqLog.error({ err, engagementId }, "list attached-documents failed");
      res.status(500).json({ error: "Failed to list attached documents" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/attached-documents/:attachedDocumentId  — fetch              */
/* -------------------------------------------------------------------------- */

router.get(
  "/attached-documents/:attachedDocumentId",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const attachedDocumentId =
      typeof req.params.attachedDocumentId === "string"
        ? req.params.attachedDocumentId
        : "";

    if (!UUID_RE.test(attachedDocumentId)) {
      res.status(404).json({ error: "attached_document_not_found" });
      return;
    }

    try {
      const rows = await db
        .select()
        .from(attachedDocuments)
        .where(eq(attachedDocuments.id, attachedDocumentId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "attached_document_not_found" });
        return;
      }
      res.json({
        attachedDocument: toAttachedDocumentAtom(row, resolveTenantId(req)),
      });
    } catch (err) {
      reqLog.error(
        { err, attachedDocumentId },
        "fetch attached-document failed",
      );
      res.status(500).json({ error: "Failed to fetch attached document" });
    }
  },
);

export default router;
