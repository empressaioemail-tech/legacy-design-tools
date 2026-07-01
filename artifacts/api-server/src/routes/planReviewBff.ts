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
import { desc, eq } from "drizzle-orm";
import {
  db,
  engagements,
  submissions,
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

function reqLog(req: Request): typeof logger {
  return (req as Request & { log?: typeof logger }).log ?? logger;
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
  res.json(
    filtered.map((row) => ({
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
    })),
  );
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
    res.json({
      id: e.id,
      name: e.name,
      jurisdiction: e.jurisdiction,
      address: e.address,
      apn: null,
      applicantName: e.applicantFirm ?? e.architectOfRecordName ?? null,
      latitude: e.latitude ? Number(e.latitude) : null,
      longitude: e.longitude ? Number(e.longitude) : null,
      reportResults: {},
    });
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
    const type = paramId(req.params.type);
    if (!isReportType(type)) {
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
    const type = paramId(req.params.type);
    if (!isReportType(type)) {
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

    res.json({ status: "not-run" });
  },
);

// ─── GET /plan-review/admin/functions ────────────────────────────

router.get("/admin/functions", requireServiceTokenOrSession, (_req: Request, res: Response) => {
  const precedenceLive = isPrecedenceEngineProductionEnabled();
  res.json([
    { id: "precedence", label: "Precedence Engine", category: "Compliance", status: precedenceLive ? "live" : "degraded", degradedReason: precedenceLive ? undefined : "Production gate not activated" },
    { id: "hydrology", label: "Hydrology", category: "Site Analysis", status: process.env.HYDROLOGY_PYSHEDS_INSTALLED === "1" ? "live" : "degraded", degradedReason: "pysheds not installed in Cloud Run worker." },
    { id: "subsurface", label: "Subsurface Suitability", category: "Site Analysis", status: "partial", degradedReason: "SSURGO ECONNRESET — USDA TLS issue." },
    { id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", status: "partial", degradedReason: "Credentials live; API contract not verified." },
    { id: "avm", label: "AVM / Valuation", category: "Market", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired." },
    { id: "rent-comps", label: "Rent / Comps", category: "Market", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06." },
  ]);
});

export default router;
