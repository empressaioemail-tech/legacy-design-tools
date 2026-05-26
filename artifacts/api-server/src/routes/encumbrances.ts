/**
 * Phase 1 — engagement-scoped encumbrance upload (R4) per ADR-020.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import Busboy from "busboy";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  engagements,
  recordedInstruments,
  restrictionClauses,
} from "@workspace/db";
import { z } from "zod";
import { logger } from "../lib/logger";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  extractEncumbranceClausesFromPdf,
  mintClauseDid,
  mintInstrumentDid,
  sourceDocumentCidFromObjectPath,
} from "../lib/encumbranceExtract";
import {
  pdfServeUrl,
  rowToRecordedInstrumentAtom,
  rowToRestrictionClauseAtom,
  type EncumbranceClauseWire,
  type EncumbranceInstrumentWire,
  type EncumbrancesListWire,
} from "../lib/encumbranceWire";

const router: IRouter = Router();
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const ENGAGEMENT_PARAMS = z.object({ id: z.string().uuid() });
const CLAUSE_VERIFY_PARAMS = z.object({
  id: z.string().uuid(),
  clauseId: z.string().uuid(),
});

let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

interface ParsedPdfUpload {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

function consumePdfUpload(
  req: Request,
): Promise<
  | { ok: true; upload: ParsedPdfUpload }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 3 },
      });
    } catch {
      resolve({ ok: false, status: 400, error: "invalid_multipart" });
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let fileSeen = false;
    let filename = "upload.pdf";
    let contentType = "application/pdf";
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
      if (name === "filename" && value) filename = value;
      if (name === "contentType" && value) contentType = value;
    });

    busboy.on(
      "file",
      (name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
        if (aborted) {
          stream.resume();
          return;
        }
        if (name !== "file" && name !== "pdf") {
          stream.resume();
          return;
        }
        fileSeen = true;
        if (info.filename) filename = info.filename;
        if (info.mimeType) contentType = info.mimeType;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_PDF_BYTES) {
            truncated = true;
            return;
          }
          chunks.push(chunk);
        });
        stream.on("limit", () => {
          truncated = true;
        });
      },
    );

    busboy.on("error", () => abort(400, "multipart_parse_failed"));
    busboy.on("finish", () => {
      if (aborted) return;
      if (!fileSeen) {
        abort(400, "missing_pdf_part");
        return;
      }
      if (truncated) {
        abort(413, "pdf_too_large");
        return;
      }
      resolve({
        ok: true,
        upload: {
          bytes: Buffer.concat(chunks, total),
          filename,
          contentType: contentType.toLowerCase().includes("pdf")
            ? contentType
            : "application/pdf",
        },
      });
    });

    req.pipe(busboy);
  });
}

async function loadEngagementOr404(
  engagementId: string,
  res: Response,
): Promise<boolean> {
  const rows = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "engagement_not_found" });
    return false;
  }
  return true;
}

export async function loadEncumbrancesForEngagement(
  engagementId: string,
): Promise<EncumbrancesListWire> {
  const instrumentRows = await db
    .select()
    .from(recordedInstruments)
    .where(eq(recordedInstruments.engagementId, engagementId))
    .orderBy(desc(recordedInstruments.createdAt));

  const allClauses =
    instrumentRows.length === 0
      ? []
      : await db
          .select()
          .from(restrictionClauses)
          .innerJoin(
            recordedInstruments,
            eq(restrictionClauses.instrumentId, recordedInstruments.id),
          )
          .where(eq(recordedInstruments.engagementId, engagementId))
          .orderBy(desc(restrictionClauses.createdAt));

  const instruments: EncumbranceInstrumentWire[] = instrumentRows.map((row) => {
    const atom = rowToRecordedInstrumentAtom(row);
    return {
      id: row.id,
      engagementId: row.engagementId,
      instrument: atom,
      sourceObjectPath: row.sourceObjectPath,
      pdfUrl: pdfServeUrl(row.sourceObjectPath),
      uploadOriginalFilename: row.uploadOriginalFilename,
      uploadContentType: row.uploadContentType,
      uploadByteSize: row.uploadByteSize,
      extractMetadata: (row.extractMetadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    };
  });

  const clauses: EncumbranceClauseWire[] = allClauses.map(({ restriction_clauses: row }) => ({
    id: row.id,
    instrumentId: row.instrumentId,
    clause: rowToRestrictionClauseAtom(row),
    sourcePage: row.sourcePage,
    createdAt: row.createdAt.toISOString(),
  }));

  return { instruments, clauses };
}

router.post(
  "/engagements/:id/encumbrances/upload",
  async (req: Request, res: Response) => {
    const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")) {
      res.status(415).json({ error: "expected_multipart" });
      return;
    }

    if (!(await loadEngagementOr404(engagementId, res))) return;

    const parsed = await consumePdfUpload(req);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    try {
      const extract = await extractEncumbranceClausesFromPdf(parsed.upload.bytes);
      const objectPath = await objectStorage().uploadObjectEntityFromBuffer(
        parsed.upload.bytes,
        parsed.upload.contentType,
      );
      const sourceDocumentCid = sourceDocumentCidFromObjectPath(objectPath);
      const instrumentDid = mintInstrumentDid(engagementId);
      const extractedAt = new Date(extract.metadata.extractedAt);

      const [instrument] = await db
        .insert(recordedInstruments)
        .values({
          engagementId,
          instrumentDid,
          instrumentType: "other",
          recording: null,
          issuerActorDid: "did:hauska:actor:engagement-upload",
          sourceDocumentCid,
          appliesTo: { legalDescription: `Engagement ${engagementId}` },
          accessPolicy: "tenant-private",
          legalWeight: "recorded",
          verificationStatus: "machine",
          extractedAt,
          sourceAdapter: "R4",
          sourceObjectPath: objectPath,
          uploadOriginalFilename: parsed.upload.filename,
          uploadContentType: parsed.upload.contentType,
          uploadByteSize: parsed.upload.bytes.length,
          extractMetadata: extract.metadata,
        })
        .returning();

      const clauseValues = extract.clauses.map((c, index) => ({
        instrumentId: instrument!.id,
        clauseDid: mintClauseDid(instrumentDid, index),
        parentInstrumentCid: sourceDocumentCid,
        clausePath: c.clausePath,
        bodyText: c.bodyText,
        confidence: String(c.confidence),
        extractedBy: extract.metadata.documentModel,
        accessPolicy: "tenant-private",
        legalWeight: "recorded",
        reasoningSummary: c.reasoningSummary,
        sourceCitation: c.sourceCitation,
        evaluatedAt: extractedAt,
        sourcePage: c.sourcePage,
      }));

      if (clauseValues.length > 0) {
        await db.insert(restrictionClauses).values(clauseValues);
      }

      res.status(201).json(await loadEncumbrancesForEngagement(engagementId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "pdf_too_large") {
        res.status(413).json({ error: "pdf_too_large" });
        return;
      }
      logger.error({ err, engagementId }, "encumbrance upload failed");
      res.status(500).json({ error: "encumbrance_upload_failed" });
    }
  },
);

router.get("/engagements/:id/encumbrances", async (req: Request, res: Response) => {
  const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
  if (!paramsParse.success) {
    res.status(400).json({ error: "invalid_engagement_id" });
    return;
  }
  const engagementId = paramsParse.data.id;
  if (!(await loadEngagementOr404(engagementId, res))) return;

  try {
    res.json(await loadEncumbrancesForEngagement(engagementId));
  } catch (err) {
    logger.error({ err, engagementId }, "list encumbrances failed");
    res.status(500).json({ error: "encumbrances_list_failed" });
  }
});

router.patch(
  "/engagements/:id/encumbrances/clauses/:clauseId/verify",
  async (req: Request, res: Response) => {
    const paramsParse = CLAUSE_VERIFY_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const { id: engagementId, clauseId } = paramsParse.data;
    if (!(await loadEngagementOr404(engagementId, res))) return;

    const verifiedAt = new Date();
    const actorDid =
      req.session?.requestor?.id != null
        ? `did:hauska:actor:user:${req.session.requestor.id}`
        : "did:hauska:actor:system:encumbrance-verify";

    const updated = await db
      .update(restrictionClauses)
      .set({ humanVerifiedAt: verifiedAt, verifiedByActorDid: actorDid })
      .where(eq(restrictionClauses.id, clauseId))
      .returning();

    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "clause_not_found" });
      return;
    }

    const owner = await db
      .select({ engagementId: recordedInstruments.engagementId })
      .from(recordedInstruments)
      .where(
        and(
          eq(recordedInstruments.id, row.instrumentId),
          eq(recordedInstruments.engagementId, engagementId),
        ),
      )
      .limit(1);

    if (!owner[0]) {
      res.status(404).json({ error: "clause_not_found" });
      return;
    }

    try {
      res.json(await loadEncumbrancesForEngagement(engagementId));
    } catch (err) {
      logger.error({ err, engagementId, clauseId }, "verify encumbrance clause failed");
      res.status(500).json({ error: "encumbrance_verify_failed" });
    }
  },
);

export default router;
