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
import Busboy from "busboy";
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
import { ObjectStorageService } from "../lib/objectStorage";
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
import { extractPdfPlainText } from "@workspace/codes-sources/pdf-text";
import { enrichExtractedTextWithVision } from "../lib/attachedDocumentVision";
import { getVisionAnthropicClient } from "../lib/findingLlmClient";
import {
  buildAttachedDocumentExtractedText,
  buildTextSegments,
  parseDocumentTypeFilter,
  parseUploadedDocumentType,
  isAcceptedDocumentMime,
  resolveDocumentTitle,
} from "./sheetContent.logic";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

/** Upper bound on a single attached-document upload (client PDFs/photos). */
const MAX_ATTACHED_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Signed-URL path for large plan-set PDFs (bypasses Cloud Run body limit). */
const MAX_PLAN_SET_SIGNED_UPLOAD_BYTES = 100 * 1024 * 1024;
const objectStorageService = new ObjectStorageService();
/** Cap on the extracted text persisted on the row (and fed to the agent). */
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
/** Hard cap on the operator-supplied note field. */
const MAX_DOCUMENT_NOTE_CHARS = 32 * 1024;

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
/*  POST .../attached-documents/request-upload-url — signed GCS upload (large) */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/attached-documents/request-upload-url",
  async (req: Request, res: Response): Promise<void> => {
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const { name, size, contentType } = req.body ?? {};
    if (typeof size === "number" && size > MAX_PLAN_SET_SIGNED_UPLOAD_BYTES) {
      res.status(413).json({
        error: `Upload too large: ${size} bytes exceeds the ${MAX_PLAN_SET_SIGNED_UPLOAD_BYTES}-byte cap.`,
      });
      return;
    }
    if (contentType !== "application/pdf") {
      res.status(415).json({ error: "expected_application_pdf" });
      return;
    }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof size !== "number" ||
      size <= 0
    ) {
      res.status(400).json({ error: "invalid_upload_metadata" });
      return;
    }
    try {
      const rows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (rows.length === 0) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      });
    } catch (err) {
      logger.error({ err, engagementId }, "attached-document presign failed");
      res.status(500).json({ error: "presign_failed" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  POST .../attached-documents/complete-upload — register signed upload      */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/attached-documents/complete-upload",
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
    const {
      objectPath,
      name,
      size,
      contentType,
      title,
      documentType,
      note,
    } = req.body ?? {};
    if (
      typeof objectPath !== "string" ||
      !objectPath.startsWith("/objects/") ||
      typeof name !== "string" ||
      typeof size !== "number" ||
      size > MAX_PLAN_SET_SIGNED_UPLOAD_BYTES ||
      contentType !== "application/pdf"
    ) {
      res.status(400).json({ error: "invalid_complete_upload_body" });
      return;
    }
    const typeParse = parseUploadedDocumentType(
      typeof documentType === "string" ? documentType : null,
    );
    if (!typeParse.ok) {
      res.status(400).json({ error: typeParse.error });
      return;
    }
    const resolvedTitle = resolveDocumentTitle(
      typeof title === "string" ? title : null,
      name,
    );
    let fileBytes: Buffer;
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(
        objectPath,
      );
      const response = await objectStorageService.downloadObject(objectFile);
      if (!response.body) {
        res.status(404).json({ error: "uploaded_object_missing" });
        return;
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_PLAN_SET_SIGNED_UPLOAD_BYTES) {
            res.status(413).json({ error: "file_too_large" });
            return;
          }
          chunks.push(value);
        }
      }
      fileBytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } catch (err) {
      reqLog.error({ err, engagementId, objectPath }, "complete-upload fetch failed");
      res.status(404).json({ error: "uploaded_object_missing" });
      return;
    }
    const parts = {
      fileBytes,
      filename: name,
      mimeType: "application/pdf",
      title: typeof title === "string" ? title : null,
      documentType: typeParse.value,
      note: typeof note === "string" ? note.slice(0, MAX_DOCUMENT_NOTE_CHARS) : "",
    };
    await persistAttachedDocumentFromParts(req, res, engagementId, parts, objectPath);
  },
);

async function persistAttachedDocumentFromParts(
  req: Request,
  res: Response,
  engagementId: string,
  parts: DocumentUploadParts,
  originalBlobRef: string,
): Promise<void> {
  const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
  const resolvedTitle = resolveDocumentTitle(parts.title, parts.filename);
  const documentType =
    (parts.documentType as AttachedDocumentType | null) ?? "narrative";

  let extractedText: string;
  let lowTextExtraction = false;
  try {
    const built = await buildAttachedDocumentExtractedText({
      mimeType: parts.mimeType,
      note: parts.note,
      fileBytes: parts.fileBytes,
      maxChars: MAX_EXTRACTED_TEXT_CHARS,
      extractPdfPlainText,
    });
    extractedText = built.extractedText;
    lowTextExtraction = built.lowTextExtraction === true;
  } catch (err) {
    if ((err as Error).message === "pdf_too_large") {
      res.status(413).json({ error: "pdf_too_large" });
      return;
    }
    reqLog.error({ err, engagementId }, "attached-document: PDF extract failed");
    res.status(500).json({ error: "pdf_extract_failed" });
    return;
  }

  try {
    const visionClient = await getVisionAnthropicClient();
    const visionResult = await enrichExtractedTextWithVision({
      docId: randomUUID(),
      title: resolvedTitle,
      mimeType: parts.mimeType,
      fileBytes: parts.fileBytes,
      baseExtractedText: extractedText,
      lowTextExtraction,
      visionClient,
      log: (msg, meta) => reqLog.info(meta ?? {}, msg),
    });
    extractedText = visionResult.extractedText;
  } catch (err) {
    reqLog.warn({ err, engagementId }, "attached-document: vision read failed");
  }

  const actor = resolveEventActor(req);
  try {
    const [row] = await db
      .insert(attachedDocuments)
      .values({
        engagementId,
        title: resolvedTitle,
        documentType,
        extractedText,
        originalBlobRef,
        actorId: actor.id,
      })
      .returning();
    if (!row) throw new Error("attached_documents insert returned no row");

    const atom = toAttachedDocumentAtom(row, resolveTenantId(req));
    await recordLSurfaceEvent(reqLog, {
      entityType: "attached-document",
      entityId: row.id,
      eventType: "attached-document.attached",
      actor,
      payload: {
        engagementId,
        documentType,
        title: resolvedTitle,
        mimeType: parts.mimeType,
        fileSizeBytes: parts.fileBytes.length,
      },
    });

    res.status(201).json({ attachedDocument: atom });
  } catch (err) {
    reqLog.error({ err, engagementId }, "attached-document: db insert failed");
    res.status(500).json({ error: "db_error" });
  }
}

/* -------------------------------------------------------------------------- */
/*  POST /api/engagements/:engagementId/attached-documents  — operator upload  */
/*  (QA-18 — engagement-scoped client PDF / photo / note upload)              */
/* -------------------------------------------------------------------------- */

interface DocumentUploadParts {
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  title: string | null;
  documentType: string | null;
  note: string;
}

/**
 * Drive the Busboy multipart parse for the attached-document upload to
 * completion. Collects one `file` part plus the `title` / `documentType`
 * / `note` text fields. Mirrors the IFC ingest's `consumeUpload` shape.
 */
function consumeDocumentUpload(
  req: Request,
): Promise<
  | { ok: true; parts: DocumentUploadParts }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_ATTACHED_DOCUMENT_BYTES,
          files: 1,
          fields: 8,
        },
      });
    } catch (err) {
      logger.warn({ err }, "attached-document upload: busboy init failed");
      resolve({ ok: false, status: 400, error: "invalid_multipart" });
      return;
    }

    const fields: Record<string, string> = {};
    const fileChunks: Buffer[] = [];
    let fileBytes = 0;
    let fileTruncated = false;
    let fileSeen = false;
    let filename = "";
    let mimeType = "";
    let aborted = false;

    function abort(status: number, error: string) {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(busboy);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status, error });
    }

    busboy.on("field", (name, value) => {
      if (aborted) return;
      if (name === "title" || name === "documentType" || name === "note") {
        fields[name] = value;
      }
    });

    busboy.on(
      "file",
      (
        name: string,
        stream: NodeJS.ReadableStream,
        info: { mimeType: string; filename: string },
      ) => {
        if (aborted || name !== "file") {
          stream.resume();
          return;
        }
        fileSeen = true;
        filename = info.filename ?? "";
        mimeType = info.mimeType ?? "";
        stream.on("data", (chunk: Buffer) => {
          fileBytes += chunk.length;
          if (fileBytes > MAX_ATTACHED_DOCUMENT_BYTES) {
            fileTruncated = true;
            return;
          }
          fileChunks.push(chunk);
        });
        stream.on("limit", () => {
          fileTruncated = true;
        });
        stream.on("error", (err) => {
          logger.warn(
            { err, filename },
            "attached-document upload: file stream error",
          );
        });
      },
    );

    busboy.on("error", (err) => {
      logger.warn({ err }, "attached-document upload: busboy error");
      abort(400, "multipart_parse_failed");
    });

    busboy.on("finish", () => {
      if (aborted) return;
      if (!fileSeen) {
        abort(400, "missing_file_part");
        return;
      }
      if (fileTruncated) {
        abort(413, "file_too_large");
        return;
      }
      resolve({
        ok: true,
        parts: {
          fileBytes: Buffer.concat(fileChunks, fileBytes),
          filename,
          mimeType,
          title: fields.title ?? null,
          documentType: fields.documentType ?? null,
          note: (fields.note ?? "").slice(0, MAX_DOCUMENT_NOTE_CHARS),
        },
      });
    });

    req.pipe(busboy);
  });
}

router.post(
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
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      res.status(415).json({ error: "expected_multipart" });
      return;
    }

    // The engagement must exist before we accept a blob bound to it.
    let engagementExists: boolean;
    try {
      const rows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      engagementExists = rows.length > 0;
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "attached-document upload: engagement lookup failed",
      );
      res.status(500).json({ error: "db_error" });
      return;
    }
    if (!engagementExists) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const consumed = await consumeDocumentUpload(req);
    if (!consumed.ok) {
      res.status(consumed.status).json({ error: consumed.error });
      return;
    }
    const { parts } = consumed;

    if (parts.fileBytes.length === 0) {
      res.status(400).json({ error: "empty_file" });
      return;
    }
    if (!isAcceptedDocumentMime(parts.mimeType)) {
      res
        .status(415)
        .json({ error: "unsupported_document_type", detail: parts.mimeType });
      return;
    }
    const typeParse = parseUploadedDocumentType(parts.documentType);
    if (!typeParse.ok) {
      res.status(400).json({ error: typeParse.error });
      return;
    }
    parts.documentType = typeParse.value;

    // Persist the original blob first so a later DB failure still leaves
    // the bytes recoverable for triage.
    let originalBlobRef: string;
    try {
      originalBlobRef = await objectStorageService.uploadObjectEntityFromBuffer(
        parts.fileBytes,
        parts.mimeType || "application/octet-stream",
      );
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "attached-document upload: blob store failed",
      );
      res.status(500).json({ error: "storage_error" });
      return;
    }

    await persistAttachedDocumentFromParts(
      req,
      res,
      engagementId,
      parts,
      originalBlobRef,
    );
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
