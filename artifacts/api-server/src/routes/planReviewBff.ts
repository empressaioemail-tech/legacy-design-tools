/**
 * Plan-review BFF â€” browser-safe aggregation over existing engine routes.
 * Mounted at `/api/plan-review/*`.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
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
  savedWorkspaceSpaces,
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
import { assembleDeliverable } from "../lib/assembleDeliverable";
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
import { resolvePlace } from "../lib/placeResolve";
import {
  ingestDataroomDocument,
  loadDataroomAtomsForDocument,
  loadDataroomAtomsForEngagement,
} from "../lib/dataroomIngest";
import { EngineSpineError } from "../lib/engineSpineClient";
import { extractSheetCrossRefs } from "../lib/sheetCrossRefs";
import { runSheetContentExtraction } from "../lib/sheetContentExtractor";
import {
  extractAnnotationCoordinates,
  getPdfPageCount,
  rasterizePdfPage,
} from "../lib/annotationPipeline";
import type { ResponseTaskAtomInstance } from "@workspace/atoms-l-surface";
import type {
  QueueRow,
  EngagementDetail,
  LetterDraft,
  TileDefWire,
} from "@empressaio/cortex-client";
import { TILE_CAPABILITIES } from "@empressaio/cortex-client";

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

// â”€â”€â”€ POST /plan-review/intake â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/geocode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Forward-geocode an address (or reverse-project lat/lng) into a parcel
// identity for the shared active-parcel context. Backs the shell top-bar
// address-search box. Same auth as every other plan-review route
// (requireServiceTokenOrSession) so the workspace reaches it on the cookie
// session it already holds â€” the brokerage /place/resolve route is gated by
// brokerageAuth + CORS, which the workspace does not carry.
router.post(
  "/geocode",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      address?: unknown;
      lat?: unknown;
      lng?: unknown;
    };
    const address =
      typeof body.address === "string" && body.address.trim()
        ? body.address.trim()
        : undefined;
    const lat = typeof body.lat === "number" ? body.lat : undefined;
    const lng = typeof body.lng === "number" ? body.lng : undefined;
    if (!address && (lat == null || lng == null)) {
      res.status(400).json({ error: "address_or_latlng_required" });
      return;
    }
    try {
      const result = await resolvePlace(
        lat != null && lng != null
          ? { lat, lng, address }
          : { address: address! },
      );
      if ("errorClass" in result) {
        const status = result.errorClass === "geocode_miss" ? 422 : 400;
        res.status(status).json({ error: result.error, message: result.message });
        return;
      }
      res.json({
        placeKey: result.placeKey,
        apn: result.ll_uuid,
        jurisdiction: result.jurisdiction_key,
        address: address ?? null,
        lat: result.geocode.lat,
        lng: result.geocode.lng,
        city: result.geocode.city,
        state: result.geocode.state,
        confidence: result.geocode.confidence,
      });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review geocode failed");
      res.status(502).json({ error: "geocode_failed" });
    }
  },
);

// â”€â”€â”€ POST /plan-review/engagements/:id/documents/upload-url â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements/:id/documents/complete-upload â”€

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
          extractedText: `[Uploaded ${filename} â€” ${contentType}, ${fileBytes.length} bytes]`,
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

// â”€â”€â”€ GET /plan-review/engagements/:id/documents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
              // One bad blob ref must not 500 the whole list â€” surface the row
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

// â”€â”€â”€ POST /plan-review/engagements/:id/documents/:docId/ingest â”€â”€â”€
//
// The "file becomes atoms" surface. Proxies the engagement's uploaded file to
// the engine `POST /v1/document-ingest` pipeline (server-to-server, gate-front
// seam) and persists the returned atoms into `dataroom_document_atoms`. The
// atoms come back as cited, confidence-graded chips linked to
// `sourceDocumentCid`. FIREWALL: the proxy sends NO accessPolicy for the
// user upload; the engine clamps to tenant-private and we persist exactly what
// it returns â€” no auto-publish path exists here.

router.post(
  "/engagements/:id/documents/:docId/ingest",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    const documentId = paramId(req.params.docId);
    if (!engagementId || !documentId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    try {
      const result = await ingestDataroomDocument({
        engagementId,
        documentId,
        jurisdictionTenant: reviewerJurisdictionTenant(engagement),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === "document_not_found") {
        res.status(404).json({ error: "document_not_found" });
        return;
      }
      if (
        err instanceof Error &&
        err.message === "document_has_no_ingestible_blob"
      ) {
        res.status(422).json({ error: "document_has_no_ingestible_blob" });
        return;
      }
      if (err instanceof EngineSpineError) {
        // Engine unreachable / rejected â€” surface a 502 (never a 500) so the
        // tile can show a degraded banner rather than a crash.
        reqLog(req).error(
          { err, engagementId, documentId, code: err.code },
          "plan-review dataroom ingest engine error",
        );
        res.status(502).json({ error: "engine_ingest_failed", code: err.code });
        return;
      }
      reqLog(req).error(
        { err, engagementId, documentId },
        "plan-review dataroom ingest failed",
      );
      res.status(500).json({ error: "dataroom_ingest_failed" });
    }
  },
);

// â”€â”€â”€ GET /plan-review/engagements/:id/documents/:docId/atoms â”€â”€â”€â”€â”€
//
// The persisted atom chips for one dataroom file (no re-ingest).

router.get(
  "/engagements/:id/documents/:docId/atoms",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const engagementId = paramId(req.params.id);
    const documentId = paramId(req.params.docId);
    if (!engagementId || !documentId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const engagement = await loadReviewerBffEngagement(engagementId);
    if (!engagement) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }
    try {
      const atoms = await loadDataroomAtomsForDocument(documentId);
      res.json({ atoms });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId, documentId },
        "plan-review dataroom atoms load failed",
      );
      res.status(500).json({ error: "dataroom_atoms_load_failed" });
    }
  },
);

// â”€â”€â”€ GET /plan-review/engagements/:id/dataroom-atoms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The persisted atom chips for EVERY dataroom file in the engagement, keyed by
// documentId â€” the Dataroom tile's one-shot hydrate on open.

router.get(
  "/engagements/:id/dataroom-atoms",
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
      const atomsByDocument = await loadDataroomAtomsForEngagement(engagementId);
      res.json({ atomsByDocument });
    } catch (err) {
      reqLog(req).error(
        { err, engagementId },
        "plan-review dataroom engagement atoms load failed",
      );
      res.status(500).json({ error: "dataroom_atoms_load_failed" });
    }
  },
);

// â”€â”€â”€ POST /plan-review/engagements/:id/export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Assembles a downloadable review deliverable as a single PDF and returns a
// 24h signed GET url. Delegates the full render to assembleDeliverable():
// title page (brand + metadata + fail/pass summary), annotated plan pages
// (every page of every loadable source PDF, with numbered red-circle callouts
// on each annotation's mapped page), findings summary (multi-page overflow),
// and the review letter (when a draft is present). Non-PDF attachments are
// skipped; one bad document never aborts the export.

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
    // document never aborts the whole export. Only /objects/ paths are ours.
    const fetchSourcePdfBytes = async (
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
      // Findings have no engagementId column â€” key on submissionId. Get the
      // engagement's submission ids, then the findings for those submissions.
      const submissionRows = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.engagementId, engagementId));
      const submissionIds = submissionRows.map((r) => r.id);

      const [docRows, annotationRows, findingRows] = await Promise.all([
        db
          .select()
          .from(attachedDocuments)
          .where(eq(attachedDocuments.engagementId, engagementId))
          .orderBy(asc(attachedDocuments.createdAt)),
        db
          .select()
          .from(engagementAnnotations)
          .where(eq(engagementAnnotations.engagementId, engagementId)),
        submissionIds.length > 0
          ? db
              .select()
              .from(findings)
              .where(inArray(findings.submissionId, submissionIds))
          : Promise.resolve([] as (typeof findings.$inferSelect)[]),
      ]);

      const letter = planReviewLetterDrafts.get(engagementId) ?? null;

      const pdfBytes = await assembleDeliverable({
        engagement: {
          id: engagementId,
          name: engagement.name,
          address: engagement.address,
          jurisdiction: engagement.jurisdiction,
          jurisdictionCity: engagement.jurisdictionCity,
          jurisdictionState: engagement.jurisdictionState,
          applicantFirm: engagement.applicantFirm,
        },
        findings: findingRows.map((f) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          status: f.status,
          text: f.text,
          confidence: f.confidence,
          citations: f.citations,
        })),
        annotations: annotationRows
          // Track F populates author='ai', kind='finding'; render every
          // annotation carrying a 2D location so manual markups still show.
          .filter((a) => a.location2d != null)
          .map((a) => ({
            id: a.id,
            findingId: a.findingId,
            location2d: a.location2d,
          })),
        documents: docRows.map((d) => ({
          id: d.id,
          title: d.title,
          documentType: d.documentType,
          originalBlobRef: d.originalBlobRef,
        })),
        letter,
        fetchSourcePdfBytes,
      });

      const buffer = Buffer.from(pdfBytes);

      // Persist the bytes and mint a 24h signed GET url.
      // uploadObjectEntityFromBuffer writes into the private object dir and
      // returns the canonical /objects/uploads/<uuid> path.
      const objectPath = await planReviewObjectStorage.uploadObjectEntityFromBuffer(
        buffer,
        "application/pdf",
      );
      const url = await signObjectEntityGetUrl(objectPath, 60 * 60 * 24);
      res.json({ url });
    } catch (err) {
      reqLog(req).error({ err, engagementId }, "plan-review export failed");
      res.status(500).json({ error: "export_failed" });
    }
  },
);

// â”€â”€â”€ POST /plan-review/engagements/:id/submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/reviewer/engagements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get("/reviewer/engagements", requireServiceTokenOrSession, async (req: Request, res: Response) => {
  const engagementRows = await db
    .select({
      id: engagements.id,
      name: engagements.name,
      address: engagements.address,
      jurisdiction: engagements.jurisdiction,
      status: engagements.status,
      updatedAt: engagements.updatedAt,
    })
    .from(engagements)
    .orderBy(desc(engagements.updatedAt))
    .limit(100);

  // inArray([]) builds invalid SQL â€” skip the counts query on an empty listing.
  const submissionCounts = engagementRows.length === 0
    ? []
    : await db
        .select({
          engagementId: submissions.engagementId,
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(submissions)
        .where(inArray(submissions.engagementId, engagementRows.map((e) => e.id)))
        .groupBy(submissions.engagementId);

  const countsByEngagement = new Map(
    submissionCounts.map((row) => [row.engagementId, Number(row.count) || 0]),
  );

  const result = engagementRows.map((e) => ({
    id: e.id,
    name: e.name,
    address: e.address,
    jurisdiction: e.jurisdiction,
    status: e.status,
    submissionCount: countsByEngagement.get(e.id) ?? 0,
    updatedAt: e.updatedAt.toISOString(),
  }));

  res.json(result);
});

// â”€â”€â”€ GET /plan-review/engagements/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/submissions/:id/findings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/submissions/:id/findings/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST compliance-run (findings + precedence) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements/:id/reports/:type/run â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/reports/:type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/sheets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements/:id/sheets/extract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/response-tasks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/letter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements/:id/letter/generate â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ GET /plan-review/admin/functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get("/admin/functions", requireServiceTokenOrSession, (_req: Request, res: Response) => {
  const precedenceLive = isPrecedenceEngineProductionEnabled();
  const functions: TileDefWire[] = [
    { id: "precedence", label: "Precedence Engine", category: "Compliance", status: precedenceLive ? "live" : "degraded", degradedReason: precedenceLive ? undefined : "Production gate not activated" },
    { id: "hydrology", label: "Hydrology", category: "Site Analysis", status: process.env.HYDROLOGY_PYSHEDS_INSTALLED === "1" ? "live" : "degraded", degradedReason: "pysheds not installed in Cloud Run worker." },
    { id: "subsurface", label: "Subsurface Suitability", category: "Site Analysis", status: "partial", degradedReason: "SSURGO ECONNRESET â€” USDA TLS issue." },
    { id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", status: "partial", degradedReason: "Credentials live; API contract not verified." },
    { id: "avm", label: "AVM / Valuation", category: "Market", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired." },
    { id: "rent-comps", label: "Rent / Comps", category: "Market", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06." },
  ];
  res.json(functions);
});

// â”€â”€â”€ GET /plan-review/admin/tile-registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The FULL machine-readable tile capability registry (all entries with
// requires / produces / modes / mcpTools). This is DISTINCT from
// /admin/functions above, which is a status-only summary of the handful of
// non-live tiles. compose_workspace (Hauska MCP server) reads this route to
// decide which tiles a given engagement context can satisfy.
//
// Source of truth: TILE_CAPABILITIES in @empressaio/cortex-client, the same array
// the SPA derives its TILE_REGISTRY from â€” so the endpoint and the app cannot
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

// â”€â”€â”€ Engagement annotations (Track D Phase 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Engagement-scoped 2D/3D unified annotations (markup / finding overlays).
// Distinct from the submission-scoped `reviewer_annotations` routes/table â€”
// do not conflate. The wire shape mirrors `@empressaio/document-viewer`'s
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

// â”€â”€â”€ GET /plan-review/engagements/:id/annotations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ POST /plan-review/engagements/:id/annotations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ DELETE /plan-review/engagements/:id/annotations/:annotationId â”€

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

// â”€â”€â”€ GET /plan-review/engagements/:id/aps-viewer-token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // entitlement (backend/support-gated), NOT an app/secret bug â€” a fresh,
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

// â”€â”€â”€ POST /plan-review/engagements/:id/dwg-convert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ AI-vision annotation generation (Track F Phase 1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Async pipeline: rasterize each PDF page of an engagement's attached plan
// set, ask a vision model for a bounding box per FAILING finding, and
// persist the result into `engagement_annotations`.
//
// TWO HARD, NON-NEGOTIABLE INVARIANTS:
//   (1) IDEMPOTENT â€” running generation twice for the same submission must
//       NOT create duplicate annotations (pre-run skip-set + per-insert
//       re-check).
//   (2) Every generated annotation's confidence is
//       `{ value, kind: 'asserted' }` â€” NEVER 'calibrated'. An AI-vision
//       coordinate is asserted-with-provenance, not earned/calibrated
//       (company structural commitment #2).

/** Failing = blocker|concern; advisory is not failing. */
const FAILING_SEVERITIES = ["blocker", "concern"] as const;
/** Exclude rejected/overridden â€” only live findings get annotations. */
const ANNOTATABLE_STATUSES = [
  "ai-produced",
  "accepted",
  "promoted-to-architect",
] as const;

/** Confidence stamped on every AI-vision annotation. Asserted, never calibrated. */
const AI_ANNOTATION_CONFIDENCE = { value: 0.75, kind: "asserted" } as const;

type AnnotationJob = {
  status: "pending" | "running" | "done" | "error";
  progress: number;
  total: number;
  error?: string;
  createdAt: number;
};

/** In-memory job state, keyed by jobId. Process-local (fine for v1). */
const annotationJobs = new Map<string, AnnotationJob>();

/**
 * In-flight generation guard keyed `${engagementId}:${submissionId}`, mapped to
 * the live jobId. Prevents a double-click / concurrent POST from launching two
 * generation passes for the same submission (which would race past the
 * idempotency pre-check and duplicate annotations). Mirrors the `inFlightReports`
 * single-flight guard used by the reports/run route.
 */
const inFlightAnnotationJobs = new Map<string, string>();

/** Evict terminal jobs older than this so the map does not grow unbounded. */
const ANNOTATION_JOB_TTL_MS = 30 * 60 * 1000;

/** Prune finished (done/error) jobs past their TTL. Cheap; called on kickoff. */
function pruneAnnotationJobs(): void {
  const now = Date.now();
  for (const [id, job] of annotationJobs) {
    if (
      (job.status === "done" || job.status === "error") &&
      now - job.createdAt > ANNOTATION_JOB_TTL_MS
    ) {
      annotationJobs.delete(id);
    }
  }
}

type Location2dShape = {
  submissionId?: unknown;
};

/**
 * Load the engagement's failing findings (severity blocker|concern, status
 * in the annotatable set), joined findings->submissions on the engagement,
 * deduplicated by findings.id.
 */
async function loadFailingFindingsForEngagement(engagementId: string): Promise<
  Array<{ id: string; atomId: string; category: string; text: string }>
> {
  const rows = await db
    .select({
      id: findings.id,
      atomId: findings.atomId,
      category: findings.category,
      text: findings.text,
    })
    .from(findings)
    .innerJoin(submissions, eq(findings.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.engagementId, engagementId),
        inArray(findings.severity, [...FAILING_SEVERITIES]),
        inArray(findings.status, [...ANNOTATABLE_STATUSES]),
      ),
    );
  const byId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * IDEMPOTENCY defense-in-depth: does an AI annotation already exist for this
 * (engagementId, findingId, submissionId) triple? Filters location2d in JS
 * because the submissionId lives inside the jsonb blob.
 */
async function aiAnnotationExists(
  engagementId: string,
  findingId: string,
  submissionId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(engagementAnnotations)
    .where(
      and(
        eq(engagementAnnotations.engagementId, engagementId),
        eq(engagementAnnotations.findingId, findingId),
      ),
    );
  return rows.some(
    (r) =>
      r.author === "ai" &&
      (r.location2d as Location2dShape | null)?.submissionId === submissionId,
  );
}

/**
 * Async runner. Loads failing findings, computes the not-yet-annotated work
 * list (pre-run idempotency), fetches the first loadable PDF, and for each
 * page rasterizes once then asks the vision model to place every still-open
 * finding. Each insert re-checks idempotency (defense-in-depth) and stamps
 * asserted confidence. Never throws out â€” sets job.status='error' instead.
 */
async function runAnnotationGeneration(
  jobId: string,
  engagementId: string,
  submissionId: string,
): Promise<void> {
  const job = annotationJobs.get(jobId);
  if (job) job.status = "running";

  try {
    // 1. Failing findings for the engagement.
    const failing = await loadFailingFindingsForEngagement(engagementId);

    // 2. IDEMPOTENCY (pre-run): existing ai annotations for this submission.
    const existing = await db
      .select()
      .from(engagementAnnotations)
      .where(eq(engagementAnnotations.engagementId, engagementId));
    const alreadyAnnotated = new Set<string>();
    for (const r of existing) {
      if (
        r.author === "ai" &&
        (r.location2d as Location2dShape | null)?.submissionId ===
          submissionId &&
        r.findingId
      ) {
        alreadyAnnotated.add(r.findingId);
      }
    }
    const workList = failing.filter((f) => !alreadyAnnotated.has(f.id));

    const cur = annotationJobs.get(jobId);
    if (cur) cur.total = workList.length;

    if (workList.length === 0) {
      const done = annotationJobs.get(jobId);
      if (done) {
        done.status = "done";
        done.progress = done.total;
      }
      return;
    }

    // 3. Fetch the first attached document that loads as a PDF.
    const docRows = await db
      .select()
      .from(attachedDocuments)
      .where(eq(attachedDocuments.engagementId, engagementId));

    let pdfBuffer: Buffer | null = null;
    let pageCount = 0;
    for (const doc of docRows) {
      const ref = doc.originalBlobRef;
      if (!ref || !ref.startsWith("/objects/")) continue;
      try {
        const bytes = await planReviewObjectStorage.getObjectEntityBytes(ref);
        const count = await getPdfPageCount(bytes);
        if (count > 0) {
          pdfBuffer = bytes;
          pageCount = count;
          break;
        }
      } catch (dlErr) {
        logger.warn(
          { dlErr, engagementId, objectPath: ref },
          "annotation generation: object download/parse failed",
        );
      }
    }

    // No loadable PDF â€” nothing to annotate, finish clean (not an error).
    if (!pdfBuffer || pageCount === 0) {
      const done = annotationJobs.get(jobId);
      if (done) {
        done.status = "done";
        done.progress = done.total;
      }
      return;
    }

    // 4. Per page: rasterize once, then place every still-open finding.
    const placed = new Set<string>();
    for (let page = 1; page <= pageCount; page += 1) {
      const remaining = workList.filter((f) => !placed.has(f.id));
      if (remaining.length === 0) break;

      let imageBase64: string;
      try {
        imageBase64 = await rasterizePdfPage(pdfBuffer, page);
      } catch (rasterErr) {
        logger.warn(
          { rasterErr, engagementId, page },
          "annotation generation: page rasterize failed",
        );
        continue;
      }

      await Promise.all(
        remaining.map(async (finding) => {
          // First-match-wins guard: a finding may match on multiple pages.
          if (placed.has(finding.id)) return;
          try {
            const bbox = await extractAnnotationCoordinates(imageBase64, {
              findingId: finding.id,
              codeSection: finding.atomId || finding.category,
              description: finding.text,
            });
            if (!bbox) return;
            if (placed.has(finding.id)) return;

            // IDEMPOTENCY (defense-in-depth): re-check before inserting so a
            // re-run after a partial failure never duplicates.
            const exists = await aiAnnotationExists(
              engagementId,
              finding.id,
              submissionId,
            );
            if (exists) {
              placed.add(finding.id);
              return;
            }

            await db.insert(engagementAnnotations).values({
              engagementId,
              author: "ai",
              kind: "finding",
              findingId: finding.id,
              confidence: AI_ANNOTATION_CONFIDENCE,
              location2d: {
                submissionId,
                page,
                bbox: [
                  bbox.x,
                  bbox.y,
                  bbox.x + bbox.width,
                  bbox.y + bbox.height,
                ],
                label: finding.atomId || finding.category,
              },
            });
            placed.add(finding.id);
            const p = annotationJobs.get(jobId);
            if (p) p.progress += 1;
          } catch (findingErr) {
            logger.warn(
              { findingErr, engagementId, findingId: finding.id, page },
              "annotation generation: per-finding placement failed",
            );
          }
        }),
      );
    }

    const doneJob = annotationJobs.get(jobId);
    if (doneJob) {
      doneJob.status = "done";
      doneJob.progress = doneJob.total;
    }
    logger.info(
      { engagementId, submissionId, placed: placed.size, total: workList.length },
      "annotation generation complete",
    );
  } catch (err) {
    const errJob = annotationJobs.get(jobId);
    if (errJob) {
      errJob.status = "error";
      errJob.error = String(err);
    }
    logger.error(
      { err, engagementId, submissionId, jobId },
      "annotation generation failed",
    );
  }
}

// â”€â”€â”€ POST /plan-review/engagements/:id/annotations/generate â”€â”€â”€â”€â”€

router.post(
  "/engagements/:id/annotations/generate",
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
    const body = req.body as { submissionId?: unknown };
    if (typeof body.submissionId !== "string" || !body.submissionId.trim()) {
      res.status(400).json({ error: "missing_submission_id" });
      return;
    }
    const submissionId = body.submissionId.trim();

    pruneAnnotationJobs();

    // Single-flight: if a generation for this exact submission is already
    // running, return its jobId rather than launching a duplicate pass (a
    // concurrent double-click would otherwise race past the idempotency
    // pre-check and duplicate annotations).
    const flightKey = `${engagementId}:${submissionId}`;
    const existingJobId = inFlightAnnotationJobs.get(flightKey);
    if (existingJobId) {
      const existing = annotationJobs.get(existingJobId);
      if (existing && (existing.status === "pending" || existing.status === "running")) {
        res.status(202).json({ jobId: existingJobId });
        return;
      }
      // Stale mapping (job already terminal) â€” clear and fall through.
      inFlightAnnotationJobs.delete(flightKey);
    }

    const jobId = randomUUID();
    annotationJobs.set(jobId, {
      status: "pending",
      progress: 0,
      total: 0,
      createdAt: Date.now(),
    });
    inFlightAnnotationJobs.set(flightKey, jobId);

    // Fire-and-forget. runAnnotationGeneration swallows its own errors into
    // job state; the extra catch guards against a synchronous throw. The
    // in-flight guard is released in all cases.
    void (async () => {
      try {
        await runAnnotationGeneration(jobId, engagementId, submissionId);
      } catch (err) {
        const j = annotationJobs.get(jobId);
        if (j) {
          j.status = "error";
          j.error = String(err);
        }
      } finally {
        if (inFlightAnnotationJobs.get(flightKey) === jobId) {
          inFlightAnnotationJobs.delete(flightKey);
        }
      }
    })();

    res.status(202).json({ jobId });
  },
);

// â”€â”€â”€ GET /plan-review/engagements/:id/annotations/generate/:jobId â”€

router.get(
  "/engagements/:id/annotations/generate/:jobId",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const jobId = paramId(req.params.jobId);
    const job = jobId ? annotationJobs.get(jobId) : undefined;
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.status(200).json({
      status: job.status,
      progress: job.progress,
      total: job.total,
      ...(job.error ? { error: job.error } : {}),
    });
  },
);

// â”€â”€â”€ Saved workspace spaces (Phase 2 shell experience) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Server-persisted, shareable named workspace layouts. Replaces the
// localStorage-only saved-spaces store. Rows are keyed by (tenantId,
// ownerUserId) so the store becomes tenant-private cleanly when the auth build
// lands â€” today it resolves the anonymous/internal owner + default tenant,
// exactly like the engagement-create route above.
//
// The `snapshot` body is the shell's SpaceSnapshot (tileIds, layoutId, colFr,
// rowFr, layoutMode). It is stored verbatim as JSONB â€” the shell owns its
// shape; the server only guards the envelope.

type SavedSpaceOwner = { tenantId: string; ownerUserId: string };

/**
 * Resolve the (tenant, owner) the saved-spaces rows are keyed on. Mirrors the
 * engagement-create resolution: internal sessions map to the legacy internal
 * owner; a user requestor maps to its id; otherwise 401. Tenancy is the default
 * tenant until auth lands.
 */
function resolveSavedSpaceOwner(req: Request): SavedSpaceOwner | null {
  const ownerUserId = isInternalSession(req.session)
    ? LEGACY_INTERNAL_OWNER_USER_ID
    : req.session.requestor?.kind === "user"
      ? req.session.requestor.id
      : null;
  if (!ownerUserId) return null;
  return {
    tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
    ownerUserId,
  };
}

function isValidSnapshot(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== "object") return false;
  const s = body as Record<string, unknown>;
  // Match the shell's SpaceSnapshot shape the loader assumes (tileIds,
  // layoutId, colFr, rowFr) so a stored snapshot can't throw on load by
  // spreading a missing colFr/rowFr. layoutMode is optional.
  return (
    Array.isArray(s.tileIds) &&
    typeof s.layoutId === "string" &&
    Array.isArray(s.colFr) &&
    Array.isArray(s.rowFr)
  );
}

// GET /plan-review/spaces â€” list the caller's saved spaces (name + id only).
router.get(
  "/spaces",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const owner = resolveSavedSpaceOwner(req);
    if (!owner) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      const rows = await db
        .select({
          id: savedWorkspaceSpaces.id,
          name: savedWorkspaceSpaces.name,
          shareToken: savedWorkspaceSpaces.shareToken,
          updatedAt: savedWorkspaceSpaces.updatedAt,
        })
        .from(savedWorkspaceSpaces)
        .where(
          and(
            eq(savedWorkspaceSpaces.tenantId, owner.tenantId),
            eq(savedWorkspaceSpaces.ownerUserId, owner.ownerUserId),
          ),
        )
        .orderBy(desc(savedWorkspaceSpaces.updatedAt));
      res.json(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          shareToken: r.shareToken ?? null,
          updatedAt: r.updatedAt,
        })),
      );
    } catch (err) {
      reqLog(req).error({ err }, "plan-review list spaces failed");
      res.status(500).json({ error: "list_failed" });
    }
  },
);

// GET /plan-review/spaces/by-name/:name â€” load one space snapshot by name.
router.get(
  "/spaces/by-name/:name",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const owner = resolveSavedSpaceOwner(req);
    if (!owner) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const name = String(req.params.name);
    try {
      const [row] = await db
        .select()
        .from(savedWorkspaceSpaces)
        .where(
          and(
            eq(savedWorkspaceSpaces.tenantId, owner.tenantId),
            eq(savedWorkspaceSpaces.ownerUserId, owner.ownerUserId),
            eq(savedWorkspaceSpaces.name, name),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "space_not_found" });
        return;
      }
      res.json({
        id: row.id,
        name: row.name,
        snapshot: row.snapshot,
        shareToken: row.shareToken ?? null,
      });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review load space failed");
      res.status(500).json({ error: "load_failed" });
    }
  },
);

// PUT /plan-review/spaces â€” upsert a named space (save/update by name).
router.put(
  "/spaces",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const owner = resolveSavedSpaceOwner(req);
    if (!owner) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const body = req.body as { name?: unknown; snapshot?: unknown };
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name_required" });
      return;
    }
    if (!isValidSnapshot(body?.snapshot)) {
      res.status(400).json({ error: "invalid_snapshot" });
      return;
    }
    try {
      const [row] = await db
        .insert(savedWorkspaceSpaces)
        .values({
          tenantId: owner.tenantId,
          ownerUserId: owner.ownerUserId,
          name,
          snapshot: body.snapshot,
        })
        .onConflictDoUpdate({
          target: [
            savedWorkspaceSpaces.tenantId,
            savedWorkspaceSpaces.ownerUserId,
            savedWorkspaceSpaces.name,
          ],
          set: { snapshot: body.snapshot, updatedAt: new Date() },
        })
        .returning();
      res.status(200).json({ id: row?.id, name });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review save space failed");
      res.status(500).json({ error: "save_failed" });
    }
  },
);

// DELETE /plan-review/spaces/by-name/:name â€” remove a named space.
router.delete(
  "/spaces/by-name/:name",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const owner = resolveSavedSpaceOwner(req);
    if (!owner) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      await db
        .delete(savedWorkspaceSpaces)
        .where(
          and(
            eq(savedWorkspaceSpaces.tenantId, owner.tenantId),
            eq(savedWorkspaceSpaces.ownerUserId, owner.ownerUserId),
            eq(savedWorkspaceSpaces.name, String(req.params.name)),
          ),
        );
      res.status(200).json({ ok: true });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review delete space failed");
      res.status(500).json({ error: "delete_failed" });
    }
  },
);

// POST /plan-review/spaces/by-name/:name/share â€” mint (or return) a share token.
router.post(
  "/spaces/by-name/:name/share",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    const owner = resolveSavedSpaceOwner(req);
    if (!owner) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      const [existing] = await db
        .select()
        .from(savedWorkspaceSpaces)
        .where(
          and(
            eq(savedWorkspaceSpaces.tenantId, owner.tenantId),
            eq(savedWorkspaceSpaces.ownerUserId, owner.ownerUserId),
            eq(savedWorkspaceSpaces.name, String(req.params.name)),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: "space_not_found" });
        return;
      }
      const shareToken = existing.shareToken ?? randomUUID();
      if (!existing.shareToken) {
        await db
          .update(savedWorkspaceSpaces)
          .set({ shareToken, updatedAt: new Date() })
          .where(eq(savedWorkspaceSpaces.id, existing.id));
      }
      res.json({ shareToken });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review share space failed");
      res.status(500).json({ error: "share_failed" });
    }
  },
);

// GET /plan-review/spaces/shared/:token â€” read-only fetch by share link.
// Deliberately NOT owner-scoped (that is the point of a share link), but still
// tenant-private-ready: a shared space is only reachable via its unguessable
// token, and never pooled or listed cross-tenant.
router.get(
  "/spaces/shared/:token",
  requireServiceTokenOrSession,
  async (req: Request, res: Response) => {
    try {
      const [row] = await db
        .select({
          name: savedWorkspaceSpaces.name,
          snapshot: savedWorkspaceSpaces.snapshot,
        })
        .from(savedWorkspaceSpaces)
        .where(eq(savedWorkspaceSpaces.shareToken, String(req.params.token)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "share_not_found" });
        return;
      }
      res.json({ name: row.name, snapshot: row.snapshot });
    } catch (err) {
      reqLog(req).error({ err }, "plan-review load shared space failed");
      res.status(500).json({ error: "load_failed" });
    }
  },
);

export default router;
