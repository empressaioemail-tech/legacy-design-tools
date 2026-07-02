/**
 * Plan-review BFF — browser-safe aggregation over existing engine routes.
 * Mounted at `/api/plan-review/*`.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  engagements,
  engagementAnnotations,
  findings,
  submissions,
  attachedDocuments,
  snapshots,
  sheets,
  responseTasks,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  isPrecedenceEngineProductionEnabled,
  precedenceResultsFromCodeSections,
} from "../lib/planReviewPrecedence";
import { usdaSsurgoSoilsAdapter } from "@workspace/adapters/federal/usda-ssurgo";
import { AdapterRunError } from "@workspace/adapters/types";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";
import {
  findEngagementInFlightFindingRun,
  loadOpenFindingCountBySubmissionIds,
} from "../lib/findingRunsEngagement";
import { kickoffFindingGenerationForSubmission, resolveEngineInputs } from "./findings";
import { resolveJurisdictionTenant } from "../lib/atomAdjudicationEvidenceLedger";
import { getHistoryService } from "../atoms/registry";
import { ingestSiteTopography } from "../lib/siteTopographyIngest";
import {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
} from "../lib/siteTopographyMaterializer";
import { ingestSiteDrainage } from "../lib/siteDrainageIngest";
import {
  loadActiveSiteDrainageRow,
  rematerializeSiteDrainageFromLatestEvent,
} from "../lib/siteDrainageMaterializer";
import {
  loadReviewerBffEngagement,
  listReviewerEngagementSubmissions,
} from "../lib/planReviewReviewerReads";
import {
  getSubmissionFindingsGenerationStatusWire,
  listSubmissionFindingsWire,
} from "./findings";
import { parseCreateEngagementBody } from "./packages.logic";
import { ObjectStorageService, signObjectEntityGetUrl } from "../lib/objectStorage";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";
import { isInternalSession } from "../lib/engagementOwnership";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import {
  emitEngagementSubmittedEvent,
  SUBMISSION_INGEST_ACTOR,
} from "../lib/engagementEvents";
import { autoTriggerClassificationOnSubmissionCreated } from "../lib/autoTriggerClassificationOnSubmissionCreated";
import { autoTriggerFindingsOnSubmissionCreated } from "../lib/autoTriggerFindingsOnSubmissionCreated";
import {
  loadBriefReportResult,
  loadEncumbrancesReportResult,
  loadHazardReportResult,
  runBriefReportForEngagement,
  runHazardAdaptersForEngagement,
} from "../lib/planReviewLayerRun";
import { extractSheetCrossRefs } from "../lib/sheetCrossRefs";
import { runSheetContentExtraction } from "../lib/sheetContentExtractor";
import type { ResponseTaskAtomInstance } from "@workspace/atoms-l-surface";
import type {
  QueueRow,
  EngagementDetail,
  LetterDraft,
  TileDefWire,
} from "@hauska/cortex-client";
import { TILE_CAPABILITIES } from "@hauska/cortex-client";

const planReviewObjectStorage = new ObjectStorageService();

/** In-memory letter drafts for reviewer QA workspace (Wave 3). */
export const planReviewLetterDrafts = new Map<
  string,
  { draft: string; generatedAt: string }
>();

function paramId(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

const router: IRouter = Router();

const INTAKE_MODES = ["link", "file", "paste", "email"] as const;
const REPORT_TYPES = [
  "compliance",
  "topography",
  "drainage",
  "hydrology",
  "hazard",
  "encumbrances",
  "brief",
  "subsurface",
  "avm",
] as const;

type ReportType = (typeof REPORT_TYPES)[number];

function isReportType(v: string): v is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(v);
}

function normalizeReportType(raw: string): ReportType | null {
  if (raw === "property-brief") return "brief";
  return isReportType(raw) ? raw : null;
}

function reqLog(req: Request): typeof logger {
  return (req as Request & { log?: typeof logger }).log ?? logger;
}

function resolveEngagementApn(siteContextRaw: unknown): string | null {
  if (!siteContextRaw || typeof siteContextRaw !== "object") return null;
  const raw = siteContextRaw as Record<string, unknown>;
  for (const key of ["apn", "parcelApn", "parcel_id", "parcelId"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const intake = raw.intake;
  if (intake && typeof intake === "object") {
    const i = intake as Record<string, unknown>;
    for (const key of ["apn", "parcelApn"]) {
      const v = i[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function reviewerJurisdictionTenant(
  engagement: typeof engagements.$inferSelect,
): string | null {
  return resolveJurisdictionTenant({
    cortexJurisdictionKey: engagement.cortexJurisdictionKey,
    jurisdictionCity: engagement.jurisdictionCity,
    jurisdictionState: engagement.jurisdictionState,
    jurisdiction: engagement.jurisdiction,
    address: engagement.address,
  });
}

// ─── POST /plan-review/intake ────────────────────────────────────

router.post("/intake", requireServiceTokenOrSession, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const mode = body.mode;
  const content = body.content;

  if (!INTAKE_MODES.includes(mode as (typeof INTAKE_MODES)[number])) {
    res.status(400).json({ error: "invalid_mode" });
    return;
  }

  const chunks: string[] = Array.isArray(content)
    ? content.map(String)
    : typeof content === "string"
      ? [content]
      : [];

  if (chunks.length === 0 || chunks.every((c) => !c.trim())) {
    res.status(400).json({ error: "empty_intake_material" });
    return;
  }

  const results = [];
  for (const material of chunks) {
    try {
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        temperature: 0,
        system:
          "Extract draft intake fields. Return ONLY valid JSON. Mark unverified fields.",
        messages: [
          {
            role: "user",
            content: `Mode: ${mode}\nMaterial:\n${material.slice(0, 12_000)}`,
          },
        ],
      });
      const text =
        resp.content[0]?.type === "text" ? resp.content[0].text : "{}";
      const parsed = JSON.parse(text) as Record<string, unknown>;
      results.push({
        projectName: String(parsed.projectName ?? ""),
        address: String(parsed.address ?? ""),
        jurisdiction: String(parsed.jurisdiction ?? ""),
        projectType: String(parsed.projectType ?? ""),
        clientName: String(parsed.clientName ?? ""),
        clientEmail: String(parsed.clientEmail ?? ""),
        clientNotes: String(parsed.clientNotes ?? ""),
        unverifiedFields: Array.isArray(parsed.unverifiedFields)
          ? parsed.unverifiedFields.map(String)
          : [],
        sources: Array.isArray(parsed.sources)
          ? parsed.sources.map((s: { kind?: string; label?: string }) => ({
              kind: String(s.kind ?? "unknown"),
              label: String(s.label ?? ""),
            }))
          : [],
      });
    } catch (err) {
      logger.warn({ err }, "plan-review intake parse failed");
      results.push({
        projectName: "",
        address: "",
        jurisdiction: "",
        projectType: "",
        clientName: "",
        clientEmail: "",
        clientNotes: material.slice(0, 500),
        unverifiedFields: ["all"],
        sources: [{ kind: String(mode), label: "raw material" }],
      });
    }
  }
  res.json(results);
});

// ─── POST /plan-review/engagements ───────────────────────────────

router.post("/engagements", requireServiceTokenOrSession, async (req: Request, res: Response) => {
  const parsed = parseCreateEngagementBody(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const ownerUserId = isInternalSession(req.session)
    ? LEGACY_INTERNAL_OWNER_USER_ID
    : req.session.requestor?.kind === "user"
      ? req.session.requestor.id
      : null;
  if (!ownerUserId) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  try {
    const nameLower = parsed.name.toLowerCase();
    const [row] = await db
      .insert(engagements)
      .values({
        name: parsed.name,
        nameLower,
        status: "active",
        address: parsed.address ?? null,
        jurisdiction: parsed.jurisdiction ?? null,
        projectType: parsed.projectType ?? null,
        ownerUserId,
        tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
      })
      .returning();
    if (!row) {
      res.status(500).json({ error: "create_failed" });
      return;
    }
    res.status(201).json({ engagementId: row.id });
  } catch (err) {
    reqLog(req).error({ err }, "plan-review create engagement failed");
    res.status(500).json({ error: "create_failed" });
  }
});

// ─── POST /plan-review/engagements/:id/documents/upload-url ─────

router.post(
  "/engagements/:id/documents/upload-url",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const body = req.body as { filename?: unknown; contentType?: unknown };
    const filename =
      typeof body.filename === "string" ? body.filename.trim() : "";
    const contentType =
      typeof body.contentType === "string" ? body.contentType.trim() : "";
    if (!filename || !contentType) {
      res.status(400).json({ error: "invalid_upload_metadata" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    try {
      const uploadUrl = await planReviewObjectStorage.getObjectEntityUploadURL();
      const gcsPath = planReviewObjectStorage.normalizeObjectEntityPath(uploadUrl);
      res.json({ uploadUrl, gcsPath, objectPath: gcsPath });
    } catch (err) {
      reqLog(req).error({ err, engagementId }, "plan-review presign failed");
      res.status(500).json({ error: "presign_failed" });
    }
  },
);

// ─── POST /plan-review/engagements/:id/documents/complete-upload ─

router.post(
  "/engagements/:id/documents/complete-upload",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const body = req.body as {
      objectPath?: unknown;
      filename?: unknown;
      contentType?: unknown;
      size?: unknown;
    };
    const objectPath =
      typeof body.objectPath === "string" ? body.objectPath : "";
    const filename =
      typeof body.filename === "string" ? body.filename.trim() : "";
    const contentType =
      typeof body.contentType === "string" ? body.contentType.trim() : "";
    const size = typeof body.size === "number" ? body.size : 0;
    if (
      !objectPath.startsWith("/objects/") ||
      !filename ||
      !contentType ||
      size <= 0
    ) {
      res.status(400).json({ error: "invalid_complete_upload_body" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    try {
      const objectFile = await planReviewObjectStorage.getObjectEntityFile(objectPath);
      const response = await planReviewObjectStorage.downloadObject(objectFile);
      if (!response.body) {
        res.status(404).json({ error: "uploaded_object_missing" });
        return;
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const fileBytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const [row] = await db
        .insert(attachedDocuments)
        .values({
          engagementId,
          title: filename,
          documentType: "narrative",
          extractedText: `[Uploaded ${filename} — ${contentType}, ${fileBytes.length} bytes]`,
          originalBlobRef: objectPath,
          actorId: LEGACY_INTERNAL_OWNER_USER_ID,
        })
        .returning();
      res.status(201).json({ documentId: row?.id ?? null, objectPath });
    } catch (err) {
      reqLog(req).error({ err, engagementId }, "plan-review complete-upload failed");
      res.status(500).json({ error: "complete_upload_failed" });
    }
  },
);

// ─── GET /plan-review/engagements/:id/documents ─────────────────
//
// Lists the engagement's attached documents as viewable entries, each with a
// short-lived SIGNED GCS GET url resolved from `original_blob_ref`. Documents
// whose blob ref is not an `/objects/<id>` path (or fail to sign) still appear
// with `url: null` so the tile can render the name even when the bytes aren't
// viewable.

router.get(
  "/engagements/:id/documents",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    try {
      const rows = await db
        .select()
        .from(attachedDocuments)
        .where(eq(attachedDocuments.engagementId, engagementId))
        .orderBy(asc(attachedDocuments.createdAt));

      const documents = await Promise.all(
        rows.map(async (row) => {
          let url: string | null = null;
          if (row.originalBlobRef.startsWith("/objects/")) {
            try {
              url = await signObjectEntityGetUrl(row.originalBlobRef, 3600);
            } catch (signErr) {
              // One bad blob ref must not 500 the whole list — surface the row
              // with a null url so the tile can still show its name.
              reqLog(req).warn(
                { signErr, engagementId, documentId: row.id },
                "plan-review sign document url failed",
              );
              url = null;
            }
          }
          return {
            id: row.id,
            title: row.title,
            documentType: row.documentType,
            url,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      );

      res.json({ documents });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId },
        "plan-review list documents failed",
      );
      res.status(500).json({ error: "list_documents_failed" });
    }
  },
);

// ─── POST /plan-review/engagements/:id/export ───────────────────
//
// Assembles a downloadable annotated plan set as a single PDF and returns a
// short-lived signed GET url. Uses pdf-lib (pure JS) to build a cover page and
// copy the pages of every loadable PDF document attached to the engagement.
// Non-PDF attachments (DWG, images) are skipped. For v1 annotations are counted
// on the cover page and drawn as simple rectangles when a location2d bbox maps
// to a copied page; the real AI-annotation render lands with Track F.

router.post(
  "/engagements/:id/export",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    // Read the full bytes of a stored object entity, returning null on any
    // failure (missing object, access denied, malformed ref) so one bad
    // document never aborts the whole export.
    const downloadObjectBytes = async (
      objectPath: string,
    ): Promise<Buffer | null> => {
      try {
        if (!objectPath.startsWith("/objects/")) return null;
        return await planReviewObjectStorage.getObjectEntityBytes(objectPath);
      } catch (dlErr) {
        reqLog(req).warn(
          { dlErr, engagementId, objectPath },
          "plan-review export: object download failed",
        );
        return null;
      }
    };

    try {
      const [docRows, annotationRows] = await Promise.all([
        db
          .select()
          .from(attachedDocuments)
          .where(eq(attachedDocuments.engagementId, engagementId))
          .orderBy(asc(attachedDocuments.createdAt)),
        db
          .select()
          .from(engagementAnnotations)
          .where(eq(engagementAnnotations.engagementId, engagementId)),
      ]);

      const outDoc = await PDFDocument.create();
      const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);
      const helveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

      // Cover page.
      const cover = outDoc.addPage([612, 792]); // US Letter
      const drawLine = (
        text: string,
        y: number,
        size: number,
        bold = false,
      ): void => {
        cover.drawText(text, {
          x: 54,
          y,
          size,
          font: bold ? helveticaBold : helvetica,
          color: rgb(0.1, 0.1, 0.12),
        });
      };
      drawLine("Annotated Plan Set", 720, 24, true);
      drawLine(engagement.name ?? "Engagement", 690, 14, true);
      const jurisdictionLine =
        engagement.jurisdiction ??
        [engagement.jurisdictionCity, engagement.jurisdictionState]
          .filter(Boolean)
          .join(", ") ??
        "Jurisdiction not set";
      drawLine(jurisdictionLine || "Jurisdiction not set", 668, 12);
      drawLine(`Generated ${new Date().toISOString()}`, 648, 10);

      // We track loadable source docs so the summary line is accurate; count
      // them after the copy loop below.
      let loadableDocCount = 0;

      // Map each copied PDF document to the page-index range it occupies in the
      // output so we can place annotations by (submissionId-agnostic) document
      // order. v1 keeps it simple: annotations with a location2d.page draw onto
      // the Nth copied page of the FIRST loadable document (best-effort), never
      // crashing on an out-of-range page.
      const copiedPageRefs: Array<ReturnType<typeof outDoc.getPage>> = [];

      for (const row of docRows) {
        const looksPdf =
          row.title.toLowerCase().endsWith(".pdf") ||
          row.documentType === "narrative";
        // We still attempt load for anything (PDFDocument.load throws on
        // non-PDF, which we catch), but skip the byte download for refs that
        // are clearly not ours.
        const bytes = await downloadObjectBytes(row.originalBlobRef);
        if (!bytes) continue;
        try {
          const srcDoc = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
          });
          const pageIndices = srcDoc.getPageIndices();
          const copied = await outDoc.copyPages(srcDoc, pageIndices);
          for (const p of copied) {
            outDoc.addPage(p);
            copiedPageRefs.push(p);
          }
          loadableDocCount += 1;
        } catch (loadErr) {
          // Not a loadable PDF (DWG/image/corrupt) — skip, don't crash.
          reqLog(req).warn(
            { loadErr, engagementId, documentId: row.id, looksPdf },
            "plan-review export: document not a loadable PDF, skipping",
          );
        }
      }

      // Best-effort annotation rectangles onto the copied pages.
      for (const ann of annotationRows) {
        const loc = ann.location2d as
          | {
              page?: unknown;
              bbox?: unknown;
            }
          | null
          | undefined;
        if (!loc || typeof loc !== "object") continue;
        const pageNum =
          typeof loc.page === "number" && Number.isFinite(loc.page)
            ? loc.page
            : null;
        const bbox = Array.isArray(loc.bbox) ? loc.bbox : null;
        if (pageNum == null || !bbox || bbox.length < 4) continue;
        const pageIdx = pageNum - 1; // location2d.page is 1-indexed
        const page = copiedPageRefs[pageIdx];
        if (!page) continue;
        const [x1, y1, x2, y2] = bbox as number[];
        if (![x1, y1, x2, y2].every((n) => typeof n === "number")) continue;
        try {
          const { width, height } = page.getSize();
          // bbox is 0-1 normalized, origin top-left; pdf-lib origin is
          // bottom-left, so flip the y axis.
          const rx = Math.min(x1, x2) * width;
          const rw = Math.abs(x2 - x1) * width;
          const ryTop = Math.min(y1, y2) * height;
          const rh = Math.abs(y2 - y1) * height;
          const ry = height - ryTop - rh;
          page.drawRectangle({
            x: rx,
            y: ry,
            width: rw,
            height: rh,
            borderColor: rgb(0.85, 0.15, 0.15),
            borderWidth: 1.5,
          });
        } catch {
          // Never crash on a malformed bbox / page geometry.
        }
      }

      drawLine(
        `${annotationRows.length} annotation${annotationRows.length === 1 ? "" : "s"}, ${loadableDocCount} source document${loadableDocCount === 1 ? "" : "s"}`,
        620,
        11,
      );

      const pdfBytes = await outDoc.save();
      const buffer = Buffer.from(pdfBytes);

      // Persist the bytes and mint a short-lived GET url. uploadObjectEntityFromBuffer
      // writes into the private object dir and returns the canonical /objects/<id>
      // path (no presign/PUT round-trip needed).
      const objectPath = await planReviewObjectStorage.uploadObjectEntityFromBuffer(
        buffer,
        "application/pdf",
      );
      const url = await signObjectEntityGetUrl(objectPath, 3600);
      res.json({ url });
    } catch (err) {
      reqLog(req).error({ err, engagementId }, "plan-review export failed");
      res.status(500).json({ error: "export_failed" });
    }
  },
);

// ─── POST /plan-review/engagements/:id/submissions ─────────────

router.post(
  "/engagements/:id/submissions",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const note =
      typeof (req.body as { note?: unknown }).note === "string"
        ? (req.body as { note: string }).note.trim()
        : null;
    try {
      const [inserted] = await db
        .insert(submissions)
        .values({
          engagementId: engagement.id,
          jurisdiction: engagement.jurisdiction,
          jurisdictionCity: engagement.jurisdictionCity,
          jurisdictionState: engagement.jurisdictionState,
          jurisdictionFips: engagement.jurisdictionFips,
          note,
          status: "submitted",
        })
        .returning();
      if (!inserted) {
        res.status(500).json({ error: "submission_create_failed" });
        return;
      }
      const log = reqLog(req);
      await emitEngagementSubmittedEvent(
        getHistoryService(),
        {
          engagementId: engagement.id,
          submissionId: inserted.id,
          jurisdiction: engagement.jurisdiction,
          jurisdictionCity: engagement.jurisdictionCity,
          jurisdictionState: engagement.jurisdictionState,
          note,
          actor: SUBMISSION_INGEST_ACTOR,
        },
        log,
      );
      autoTriggerFindingsOnSubmissionCreated(inserted.id, log);
      autoTriggerClassificationOnSubmissionCreated(inserted.id, log);
      res.status(201).json({
        submissionId: inserted.id,
        engagementId: engagement.id,
        submittedAt: inserted.submittedAt.toISOString(),
      });
    } catch (err) {
      reqLog(req).error({ err, engagementId }, "plan-review create submission failed");
      res.status(500).json({ error: "submission_create_failed" });
    }
  },
);

// ─── GET /plan-review/queue ──────────────────────────────────────

router.get("/queue", requireServiceTokenOrSession, async (req: Request, res: Response) => {
  const statusFilter =
    typeof req.query.status === "string" && req.query.status.length > 0
      ? req.query.status.split(",").map((s) => s.trim())
      : null;

  const rows = await db
    .select({
      id: submissions.id,
      engagementId: submissions.engagementId,
      status: submissions.status,
      submittedAt: submissions.submittedAt,
      engagementName: engagements.name,
    })
    .from(submissions)
    .innerJoin(engagements, eq(submissions.engagementId, engagements.id))
    .orderBy(desc(submissions.submittedAt))
    .limit(100);

  const filtered = statusFilter
    ? rows.filter((r) => statusFilter.includes(r.status))
    : rows;

  const submissionIds = filtered.map((r) => r.id);
  const openCounts =
    submissionIds.length > 0
      ? await loadOpenFindingCountBySubmissionIds(submissionIds)
      : new Map<string, number>();

  const inflight = await Promise.all(
    [...new Set(filtered.map((r) => r.engagementId))].map(async (eid) => {
      const run = await findEngagementInFlightFindingRun(eid);
      return [eid, run?.generationId ?? null] as const;
    }),
  );
  const inflightByEngagement = new Map(inflight);

  const now = Date.now();
  const queueRows: QueueRow[] = filtered.map((row) => ({
    id: row.id,
    engagementId: row.engagementId,
    engagementName: row.engagementName,
    status: row.status,
    reportRunState: inflightByEngagement.get(row.engagementId)
      ? "running"
      : null,
    openFindingCount: openCounts.get(row.id) ?? 0,
    daysInQueue: Math.floor(
      (now - new Date(row.submittedAt).getTime()) / 86_400_000,
    ),
  }));
  res.json(queueRows);
});

// ─── GET /plan-review/engagements/:id ────────────────────────────

router.get(
  "/engagements/:id",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const e = await loadReviewerBffEngagement(id);
    if (!e) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const detail: EngagementDetail = {
      id: e.id,
      name: e.name,
      jurisdiction: e.jurisdiction,
      address: e.address,
      apn: resolveEngagementApn(e.siteContextRaw),
      applicantName: e.applicantFirm ?? e.architectOfRecordName ?? null,
      latitude: e.latitude ? Number(e.latitude) : null,
      longitude: e.longitude ? Number(e.longitude) : null,
      reportResults: {},
    };
    res.json(detail);
  },
);

// ─── GET /plan-review/engagements/:id/submissions ────────────────

router.get(
  "/engagements/:id/submissions",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const rows = await listReviewerEngagementSubmissions(id);
    if (rows === null) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    res.json(rows);
  },
);

// ─── GET /plan-review/submissions/:id/findings ───────────────────

router.get(
  "/submissions/:id/findings",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const payload = await listSubmissionFindingsWire(id);
    if (!payload) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }
    res.json(payload);
  },
);

// ─── GET /plan-review/submissions/:id/findings/status ────────────

router.get(
  "/submissions/:id/findings/status",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const id = paramId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const payload = await getSubmissionFindingsGenerationStatusWire(id);
    if (!payload) {
      res.status(404).json({ error: "submission_not_found" });
      return;
    }
    res.json(payload);
  },
);

// ─── POST compliance-run (findings + precedence) ───────────────

router.post(
  "/engagements/:id/compliance-run",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    const submissionId =
      typeof (req.body as { submissionId?: unknown }).submissionId === "string"
        ? (req.body as { submissionId: string }).submissionId
        : "";
    if (!submissionId) {
      res.status(400).json({ error: "missing_submission_id" });
      return;
    }
    const log = reqLog(req);
    const outcome = await kickoffFindingGenerationForSubmission(
      submissionId,
      log,
    );
    if (outcome.kind === "already_running") {
      res.status(409).json({
        error: "finding_generation_already_in_flight",
        generationId: outcome.generationId,
      });
      return;
    }

    let precedenceResult: Array<{
      topic: string;
      ruleApplied: string;
      governingAtomId: string;
      comparedAtomIds: string[];
    }> = [];

    if (isPrecedenceEngineProductionEnabled()) {
      try {
        const inputs = await resolveEngineInputs(submissionId, log);
        precedenceResult = precedenceResultsFromCodeSections(inputs.codeSections);
      } catch (err) {
        log.warn({ err, submissionId }, "precedence preview failed");
      }
    }

    res.status(202).json({
      generationId: outcome.generationId,
      precedenceResult:
        precedenceResult.length > 0 ? precedenceResult : undefined,
    });
  },
);

// ─── POST /plan-review/engagements/:id/reports/:type/run ───────

const inFlightReports = new Map<string, string>();
const reportResultCache = new Map<string, unknown>();

router.post(
  "/engagements/:engagementId/reports/:type/run",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.engagementId);
    const typeRaw = paramId(req.params.type);
    const type = normalizeReportType(typeRaw);
    if (!type) {
      res.status(400).json({ error: "invalid_report_type" });
      return;
    }
    const flightKey = `${engagementId}:${type}`;
    if (inFlightReports.has(flightKey)) {
      res.status(409).json({
        error: "report_already_running",
        generationId: inFlightReports.get(flightKey),
      });
      return;
    }
    const generationId = `gen-${Date.now()}`;
    inFlightReports.set(flightKey, generationId);

    const log = reqLog(req);
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      inFlightReports.delete(flightKey);
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const jurisdictionTenant = reviewerJurisdictionTenant(engagement);

    try {
      if (type === "topography") {
        await ingestSiteTopography({
          engagementId,
          history: getHistoryService(),
          jurisdictionTenant,
          log,
        });
      } else if (
        type === "drainage" ||
        type === "hydrology"
      ) {
        await ingestSiteDrainage({
          engagementId,
          history: getHistoryService(),
          jurisdictionTenant,
          log,
        });
      } else if (type === "subsurface") {
        const [eng] = await db
          .select({
            latitude: engagements.latitude,
            longitude: engagements.longitude,
          })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1);
        if (!eng?.latitude || !eng?.longitude) {
          inFlightReports.delete(flightKey);
          res.status(422).json({ error: "engagement_not_geocoded" });
          return;
        }
        try {
          const result = await usdaSsurgoSoilsAdapter.run({
            parcel: {
              latitude: Number(eng.latitude),
              longitude: Number(eng.longitude),
            },
            jurisdiction: { stateKey: null, localKey: null },
            fetchImpl: fetch,
          });
          reportResultCache.set(flightKey, { status: "ok", result });
        } catch (err) {
          if (err instanceof AdapterRunError && err.code === "network-error") {
            reportResultCache.set(flightKey, {
              status: "unavailable",
              reason: "USDA endpoint unreachable",
            });
          } else {
            throw err;
          }
        }
      } else if (type === "hazard") {
        const outcome = await runHazardAdaptersForEngagement({
          engagementId,
          log,
        });
        if (!outcome.ok) {
          inFlightReports.delete(flightKey);
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        if (outcome.quotaExhausted) {
          reportResultCache.set(flightKey, {
            status: "ok",
            result: { quotaExhausted: true, persisted: outcome.persisted },
          });
        }
      } else if (type === "brief") {
        const outcome = await runBriefReportForEngagement({
          engagementId,
          log,
        });
        if (!outcome.ok) {
          inFlightReports.delete(flightKey);
          res
            .status(outcome.status)
            .json({
              error: outcome.error,
              generationId: outcome.generationId ?? undefined,
            });
          return;
        }
      } else if (type === "encumbrances") {
        const encResult = await loadEncumbrancesReportResult(engagementId);
        reportResultCache.set(flightKey, encResult);
      }
      inFlightReports.delete(flightKey);
      res.status(202).json({ generationId });
    } catch (err) {
      inFlightReports.delete(flightKey);
      log.error({ err, engagementId, type }, "plan-review report run failed");
      res.status(502).json({ error: "report_run_failed" });
    }
  },
);

// ─── GET /plan-review/engagements/:id/reports/:type ──────────────

router.get(
  "/engagements/:engagementId/reports/:type",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.engagementId);
    const typeRaw = paramId(req.params.type);
    const type = normalizeReportType(typeRaw);
    if (!type) {
      res.status(400).json({ error: "invalid_report_type" });
      return;
    }
    const flightKey = `${engagementId}:${type}`;
    if (inFlightReports.has(flightKey)) {
      res.json({ status: "running" });
      return;
    }

    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    if (type === "topography") {
      let row = await loadActiveSiteTopographyRow(engagementId);
      if (!row) {
        const replayed = await rematerializeFromLatestEvent({
          history: getHistoryService(),
          engagementId,
          log: reqLog(req),
        });
        if (replayed.status === "no-event") {
          res.json({ status: "not-run" });
          return;
        }
        row = await loadActiveSiteTopographyRow(engagementId);
      }
      if (!row) {
        res.json({ status: "error", error: "materialization_failed" });
        return;
      }
      const ps = row.propertySet as Record<string, unknown>;
      res.json({
        status: "ok",
        result: {
          contoursGeoJson: ps.contoursGeoJson ?? null,
          demGcsObjectPath: ps.demGcsObjectPath ?? null,
        },
      });
      return;
    }

    if (type === "drainage" || type === "hydrology") {
      let row = await loadActiveSiteDrainageRow(engagementId);
      if (!row) {
        const replayed = await rematerializeSiteDrainageFromLatestEvent({
          history: getHistoryService(),
          engagementId,
          log: reqLog(req),
        });
        if (replayed.status === "no-event") {
          res.json({ status: "not-run" });
          return;
        }
        row = await loadActiveSiteDrainageRow(engagementId);
      }
      if (!row) {
        res.json({ status: "error", error: "materialization_failed" });
        return;
      }
      const ps = row.propertySet as Record<string, unknown>;
      res.json({
        status: "ok",
        result: {
          flowLinesGeoJson: ps.flowLinesGeoJson ?? null,
          drainageZonesGeoJson: ps.drainageZonesGeoJson ?? null,
          hydrologyLibrary: ps.hydrologyLibrary ?? null,
        },
      });
      return;
    }

  if (type === "subsurface") {
    const cached = reportResultCache.get(flightKey);
    if (cached) {
      const row = cached as { status?: string; reason?: string; result?: unknown };
      if (row.status === "unavailable") {
        res.json({ status: "unavailable", result: { reason: row.reason } });
        return;
      }
      res.json({ status: "ok", result: row.result });
      return;
    }
    res.json({ status: "not-run" });
    return;
  }

  if (type === "hazard") {
    const hazard = await loadHazardReportResult(engagementId);
    if (hazard.status === "ok") {
      const cached = reportResultCache.get(flightKey) as
        | { result?: { quotaExhausted?: boolean } }
        | undefined;
      if (cached?.result?.quotaExhausted) {
        res.json({
          ...hazard,
          result: {
            ...(hazard.result as Record<string, unknown>),
            quotaExhausted: true,
          },
        });
        return;
      }
      res.json(hazard);
      return;
    }
    res.json(hazard);
    return;
  }

  if (type === "brief") {
    const brief = await loadBriefReportResult(engagementId);
    res.json(brief);
    return;
  }

  if (type === "encumbrances") {
    const enc = await loadEncumbrancesReportResult(engagementId);
    res.json(enc);
    return;
  }

    res.json({ status: "not-run" });
  },
);

// ─── GET /plan-review/engagements/:id/sheets ───────────────────

async function loadLatestSnapshotId(
  engagementId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(eq(snapshots.engagementId, engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(1);
  return row?.id ?? null;
}

router.get(
  "/engagements/:id/sheets",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const snapshotId = await loadLatestSnapshotId(engagementId);
    if (!snapshotId) {
      res.json({ sheets: [] });
      return;
    }
    const rows = await db
      .select({
        id: sheets.id,
        snapshotId: sheets.snapshotId,
        engagementId: sheets.engagementId,
        sheetNumber: sheets.sheetNumber,
        sheetName: sheets.sheetName,
        viewCount: sheets.viewCount,
        revisionNumber: sheets.revisionNumber,
        revisionDate: sheets.revisionDate,
        thumbnailWidth: sheets.thumbnailWidth,
        thumbnailHeight: sheets.thumbnailHeight,
        fullWidth: sheets.fullWidth,
        fullHeight: sheets.fullHeight,
        sortOrder: sheets.sortOrder,
        contentBody: sheets.contentBody,
        createdAt: sheets.createdAt,
      })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId))
      .orderBy(asc(sheets.sortOrder));
    res.json({
      sheets: rows.map((r) => ({
        sheetId: r.id,
        label: r.sheetName,
        pageNumber: r.sheetNumber,
        snapshotId: r.snapshotId,
        thumbnailUrl: `/api/sheets/${r.id}/thumbnail.png`,
        contentBody: r.contentBody,
        crossRefs: extractSheetCrossRefs(r.contentBody ?? ""),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

// ─── POST /plan-review/engagements/:id/sheets/extract ──────────

router.post(
  "/engagements/:id/sheets/extract",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const snapshotId = await loadLatestSnapshotId(engagementId);
    if (!snapshotId) {
      res.status(422).json({ error: "no_snapshot" });
      return;
    }
    const rows = await db
      .select({
        id: sheets.id,
        contentBody: sheets.contentBody,
        fullPng: sheets.fullPng,
      })
      .from(sheets)
      .where(eq(sheets.snapshotId, snapshotId))
      .orderBy(asc(sheets.sortOrder));
    const targets = rows
      .filter((r) => !r.contentBody && r.fullPng)
      .map((r) => ({
        sheetId: r.id,
        fullPng: Buffer.isBuffer(r.fullPng)
          ? r.fullPng
          : Buffer.from(r.fullPng as Uint8Array),
      }));
    if (targets.length === 0) {
      res.json({ extracted: 0, message: "no_sheets_need_extraction" });
      return;
    }
    const log = reqLog(req);
    await runSheetContentExtraction(targets, log);
    res.status(202).json({ extracted: targets.length });
  },
);

// ─── GET /plan-review/engagements/:id/response-tasks ─────────────

function toPlanReviewResponseTaskWire(
  row: typeof responseTasks.$inferSelect,
): ResponseTaskAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  return {
    entityType: "response-task",
    entityId: row.id,
    title: row.title,
    description: row.description,
    state: row.state as ResponseTaskAtomInstance["state"],
    createdAt: createdAtIso,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    sourceClientCommentId: row.sourceClientCommentId,
    findingId: row.findingId,
    engagementId: row.engagementId,
    actorId: row.actorId,
    principalActorId: row.principalActorId,
    accessPolicy: "tenant-private",
    jurisdictionTenant: DEFAULT_TENANT_ID,
    sourceAdapter: "legacy-design-tools",
    contentHash: "",
    fetchedAt: createdAtIso,
    sourceUrl: "",
  };
}

router.get(
  "/engagements/:id/response-tasks",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const rows = await db
      .select()
      .from(responseTasks)
      .where(eq(responseTasks.engagementId, engagementId))
      .orderBy(desc(responseTasks.createdAt));
    res.json({
      responseTasks: rows.map((r) => toPlanReviewResponseTaskWire(r)),
    });
  },
);

// ─── GET /plan-review/engagements/:id/letter ───────────────────

router.get(
  "/engagements/:id/letter",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const cached = planReviewLetterDrafts.get(engagementId);
    const letter: LetterDraft = {
      draft: cached?.draft ?? null,
      generatedAt: cached?.generatedAt ?? null,
    };
    res.json(letter);
  },
);

// ─── POST /plan-review/engagements/:id/letter/generate ─────────

router.post(
  "/engagements/:id/letter/generate",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const [latestSubmission] = await db
      .select({ id: submissions.id, submittedAt: submissions.submittedAt })
      .from(submissions)
      .where(eq(submissions.engagementId, engagementId))
      .orderBy(desc(submissions.submittedAt))
      .limit(1);
    if (!latestSubmission) {
      res.status(422).json({ error: "no_submission" });
      return;
    }
    const findingRows = await db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, latestSubmission.id))
      .orderBy(desc(findings.createdAt));
    const accepted = findingRows.filter(
      (f) =>
        f.status === "accepted" ||
        (f.status === "overridden" && f.revisionOf != null),
    );
    if (accepted.length === 0) {
      res.status(422).json({ error: "no_accepted_findings" });
      return;
    }
    const lines = accepted.map((f, i) => {
      const text =
        typeof f.text === "string" && f.text.trim()
          ? f.text.trim()
          : "Finding requires review.";
      return `${i + 1}. ${text}`;
    });
    const draft = [
      `Re: ${engagement.name}`,
      engagement.jurisdiction ? `Jurisdiction: ${engagement.jurisdiction}` : "",
      "",
      "The following comments are offered for your consideration:",
      "",
      ...lines,
      "",
      "Please revise and resubmit.",
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
    const generatedAt = new Date().toISOString();
    planReviewLetterDrafts.set(engagementId, { draft, generatedAt });
    const generated: LetterDraft = { draft, generatedAt };
    res.json(generated);
  },
);

// ─── GET /plan-review/admin/functions ────────────────────────────

router.get("/admin/functions", requireServiceTokenOrSession, (_req: Request, res: Response) => {
  const precedenceLive = isPrecedenceEngineProductionEnabled();
  const functions: TileDefWire[] = [
    { id: "precedence", label: "Precedence Engine", category: "Compliance", status: precedenceLive ? "live" : "degraded", degradedReason: precedenceLive ? undefined : "Production gate not activated" },
    { id: "hydrology", label: "Hydrology", category: "Site Analysis", status: process.env.HYDROLOGY_PYSHEDS_INSTALLED === "1" ? "live" : "degraded", degradedReason: "pysheds not installed in Cloud Run worker." },
    { id: "subsurface", label: "Subsurface Suitability", category: "Site Analysis", status: "partial", degradedReason: "SSURGO ECONNRESET — USDA TLS issue." },
    { id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", status: "partial", degradedReason: "Credentials live; API contract not verified." },
    { id: "avm", label: "AVM / Valuation", category: "Market", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired." },
    { id: "rent-comps", label: "Rent / Comps", category: "Market", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06." },
  ];
  res.json(functions);
});

// ─── GET /plan-review/admin/tile-registry ─────────────────────────
//
// The FULL machine-readable tile capability registry (all entries with
// requires / produces / modes / mcpTools). This is DISTINCT from
// /admin/functions above, which is a status-only summary of the handful of
// non-live tiles. compose_workspace (Hauska MCP server) reads this route to
// decide which tiles a given engagement context can satisfy.
//
// Source of truth: TILE_CAPABILITIES in @hauska/cortex-client, the same array
// the SPA derives its TILE_REGISTRY from — so the endpoint and the app cannot
// drift. Served verbatim; capability metadata is non-sensitive tile
// descriptors. Auth is requireServiceTokenOrSession, consistent with every
// other plan-review BFF route: the MCP server presents
// `Authorization: Bearer <service-token>` (must be valid); the browser SPA
// reaches it via the no-header session path.
router.get(
  "/admin/tile-registry",
  requireServiceTokenOrSession,
  (_req: Request, res: Response) => {
    res.json(TILE_CAPABILITIES);
  },
);

// ─── Engagement annotations (Track D Phase 2) ───────────────────
//
// Engagement-scoped 2D/3D unified annotations (markup / finding overlays).
// Distinct from the submission-scoped `reviewer_annotations` routes/table —
// do not conflate. The wire shape mirrors `@hauska/document-viewer`'s
// `Annotation` type so the DocumentViewerTile round-trips it verbatim.

const ANNOTATION_KINDS = [
  "finding",
  "redline",
  "shape",
  "text",
  "stamp",
  "dimension",
] as const;
type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

function isAnnotationKind(v: unknown): v is AnnotationKind {
  return (
    typeof v === "string" &&
    (ANNOTATION_KINDS as readonly string[]).includes(v)
  );
}

type AnnotationWire = {
  id: string;
  engagementId: string;
  author: string;
  kind: AnnotationKind;
  findingId?: string;
  confidence?: unknown;
  createdAt: string;
  location2d?: unknown;
  location3d?: unknown;
};

function annotationRowToWire(
  row: typeof engagementAnnotations.$inferSelect,
): AnnotationWire {
  return {
    id: row.id,
    engagementId: row.engagementId,
    author: row.author,
    kind: row.kind as AnnotationKind,
    findingId: row.findingId ?? undefined,
    confidence: row.confidence ?? undefined,
    createdAt: row.createdAt.toISOString(),
    location2d: row.location2d ?? undefined,
    location3d: row.location3d ?? undefined,
  };
}

// ─── GET /plan-review/engagements/:id/annotations ───────────────

router.get(
  "/engagements/:id/annotations",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    try {
      const rows = await db
        .select()
        .from(engagementAnnotations)
        .where(eq(engagementAnnotations.engagementId, engagementId))
        .orderBy(asc(engagementAnnotations.createdAt));
      res.json({ annotations: rows.map(annotationRowToWire) });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId },
        "plan-review list annotations failed",
      );
      res.status(500).json({ error: "list_annotations_failed" });
    }
  },
);

// ─── POST /plan-review/engagements/:id/annotations ──────────────

router.post(
  "/engagements/:id/annotations",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    const body = req.body as {
      author?: unknown;
      kind?: unknown;
      findingId?: unknown;
      confidence?: unknown;
      location2d?: unknown;
      location3d?: unknown;
    };
    if (!isAnnotationKind(body.kind)) {
      res.status(400).json({ error: "invalid_annotation_kind" });
      return;
    }
    const author =
      typeof body.author === "string" && body.author.trim()
        ? body.author.trim()
        : "reviewer";
    const findingId =
      typeof body.findingId === "string" && body.findingId.trim()
        ? body.findingId.trim()
        : null;
    try {
      const [row] = await db
        .insert(engagementAnnotations)
        .values({
          engagementId,
          author,
          kind: body.kind,
          findingId,
          confidence: body.confidence ?? null,
          location2d: body.location2d ?? null,
          location3d: body.location3d ?? null,
        })
        .returning();
      if (!row) {
        res.status(500).json({ error: "annotation_create_failed" });
        return;
      }
      res.status(201).json({ annotation: annotationRowToWire(row) });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId },
        "plan-review create annotation failed",
      );
      res.status(500).json({ error: "create_annotation_failed" });
    }
  },
);

// ─── DELETE /plan-review/engagements/:id/annotations/:annotationId ─

router.delete(
  "/engagements/:id/annotations/:annotationId",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    const annotationId = paramId(req.params.annotationId);
    if (!engagementId || !annotationId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    try {
      const deleted = await db
        .delete(engagementAnnotations)
        .where(
          and(
            eq(engagementAnnotations.id, annotationId),
            eq(engagementAnnotations.engagementId, engagementId),
          ),
        )
        .returning({ id: engagementAnnotations.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: "annotation_not_found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      reqLog(req).error(
        { err, engagementId, annotationId },
        "plan-review delete annotation failed",
      );
      res.status(500).json({ error: "delete_annotation_failed" });
    }
  },
);

// ─── GET /plan-review/engagements/:id/aps-viewer-token ─────────────
//
// Mints a short-lived Autodesk Platform Services (APS) viewer token for the
// DWGViewer component. APS credentials are NOT configured in this environment
// today (no APS_CLIENT_ID / APS_CLIENT_SECRET), so this route returns a NAMED
// 501 rather than a 500. When creds appear, it performs the standard APS v2
// two-legged (client_credentials) auth and returns { accessToken, expiresIn }.

router.get(
  "/engagements/:id/aps-viewer-token",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const clientId = process.env.APS_CLIENT_ID;
    const clientSecret = process.env.APS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      // Named not-configured path (AUTH-001 companion). The DWGViewer treats this
      // as its fallback signal, not an error to surface to the reviewer.
      res.status(501).json({
        error: "aps_not_configured",
        detail:
          "APS_CLIENT_ID/APS_CLIENT_SECRET not set in this environment",
      });
      return;
    }

    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      );
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        scope: "viewables:read data:read",
      });
      const apsRes = await fetch(
        "https://developer.api.autodesk.com/authentication/v2/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basic}`,
          },
          body: body.toString(),
        },
      );
      if (!apsRes.ok) {
        const detail = await apsRes.text();
        // NOTE: a 403 AUTH-001 here means the Autodesk ACCOUNT lacks APS API
        // entitlement (backend/support-gated), NOT an app/secret bug — a fresh,
        // correctly-configured app still 403s until the account is entitled.
        res.status(502).json({
          error: "aps_auth_failed",
          status: apsRes.status,
          detail,
        });
        return;
      }
      const json = (await apsRes.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!json.access_token || typeof json.expires_in !== "number") {
        res.status(502).json({
          error: "aps_auth_failed",
          status: apsRes.status,
          detail: "APS token response missing access_token/expires_in",
        });
        return;
      }
      res.json({ accessToken: json.access_token, expiresIn: json.expires_in });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId },
        "plan-review aps-viewer-token failed",
      );
      res.status(502).json({
        error: "aps_auth_failed",
        detail: "network error contacting Autodesk auth",
      });
    }
  },
);

// ─── POST /plan-review/engagements/:id/dwg-convert ─────────────────
//
// The specified LibreOffice DWG->PDF fallback: `soffice --headless --convert-to
// pdf`. Deferred and returns a NAMED 501 because (a) soffice is NOT in the Cloud
// Run runtime image (root Dockerfile ships poppler-utils/pdftoppm only, no
// LibreOffice), and (b) DWG import requires the LibreOffice DWG import filter,
// whose fidelity is unverified. When the image gains soffice, the conversion
// wiring point is HERE (feed the produced PDF to the PDFViewer path).

router.post(
  "/engagements/:id/dwg-convert",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    if (!engagementId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    res.status(501).json({
      error: "dwg_conversion_unavailable",
      detail:
        "Server-side DWG->PDF conversion requires LibreOffice in the Cloud Run image; not installed. Attach a PDF or IFC instead.",
    });
  },
);

export default router;
