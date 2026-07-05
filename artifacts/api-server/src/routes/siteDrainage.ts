/**
 * Site-drainage routes — Phase 2D.2/2D.3.
 *
 *   POST /api/engagements/:id/site-drainage/refresh
 *   GET  /api/engagements/:id/site-drainage
 *   GET  /api/engagements/:id/site-drainage/design-storms  (NOAA Atlas 14)
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, engagements as engagementsTable } from "@workspace/db";
import { fetchNoaaAtlas14PointEstimate } from "@workspace/site-context/server";
import { logger } from "../lib/logger";
import { requireGateEngineServiceAuth } from "../middlewares/gateEngineServiceAuth";
import { verifyGateContext } from "../middlewares/gateContextVerification";
import { assertEngagementServiceTenantScope } from "../lib/gateFrontSeamEngagement";
import { getHistoryService } from "../atoms/registry";
import {
  ingestSiteDrainage,
  type SiteDrainageIngestResult,
} from "../lib/siteDrainageIngest";
import {
  loadActiveSiteDrainageRow,
  rematerializeSiteDrainageFromLatestEvent,
} from "../lib/siteDrainageMaterializer";

const router: IRouter = Router();

router.use(requireGateEngineServiceAuth);
router.use(verifyGateContext);

const REFRESH_BODY_SCHEMA = z
  .object({
    manualDepthInches: z.number().positive().max(50).optional(),
    returnPeriodYears: z.number().int().positive().max(500).optional(),
    accumulationThreshold: z.number().int().positive().max(10_000).optional(),
    forceRefresh: z.boolean().optional(),
    useCotalityForcing: z.boolean().optional(),
  })
  .strict();

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

export function ingestDrainageResultToHttp(
  result: SiteDrainageIngestResult,
): { status: number; body: Record<string, unknown> } {
  if (result.status === "ok") {
    return {
      status: 200,
      body: {
        status: "ok",
        atomEventId: result.atomEventId,
        eventType: result.eventType,
        materializableElementId: result.materializableElementId,
        flowLineCount: result.flowLineCount,
        drainageZoneCount: result.drainageZoneCount,
        rainfallDepthInches: result.rainfallDepthInches,
        forcingSource: result.forcingSource,
        reusedExisting: result.reusedExisting,
      },
    };
  }
  if (result.status === "no-topography") {
    return { status: 422, body: { status: "no-topography", reason: result.reason } };
  }
  const httpStatus = result.code === "dem-download-failed" ? 502 : 502;
  return {
    status: httpStatus,
    body: { status: "upstream-error", code: result.code, reason: result.reason },
  };
}

router.post(
  "/engagements/:id/site-drainage/refresh",
  async (req: Request, res: Response) => {
    const engagementId = typeof req.params.id === "string" ? req.params.id : "";
    if (!engagementId) {
      res.status(400).json({ error: "missing_engagement_id" });
      return;
    }
    const parsed = REFRESH_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const log = reqLog(req);
    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }
    let result: SiteDrainageIngestResult;
    try {
      result = await ingestSiteDrainage({
        engagementId,
        history: getHistoryService(),
        jurisdictionTenant: tenantScope.jurisdictionTenant,
        manualDepthInches: parsed.data.manualDepthInches,
        returnPeriodYears: parsed.data.returnPeriodYears,
        accumulationThreshold: parsed.data.accumulationThreshold,
        forceRefresh: parsed.data.forceRefresh,
        useCotalityForcing: parsed.data.useCotalityForcing,
        log,
      });
    } catch (err) {
      log.error({ err, engagementId }, "site-drainage refresh: unhandled error");
      res.status(500).json({
        error: "internal_worker_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const { status, body } = ingestDrainageResultToHttp(result);
    res.status(status).json(body);
  },
);

router.get(
  "/engagements/:id/site-drainage",
  async (req: Request, res: Response) => {
    const engagementId = typeof req.params.id === "string" ? req.params.id : "";
    if (!engagementId) {
      res.status(400).json({ error: "missing_engagement_id" });
      return;
    }
    const log = reqLog(req);
    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }
    let row = await loadActiveSiteDrainageRow(engagementId);
    if (!row) {
      const replayed = await rematerializeSiteDrainageFromLatestEvent({
        history: getHistoryService(),
        engagementId,
        log,
      });
      if (replayed.status === "no-event") {
        res.status(404).json({ status: "not-found", reason: replayed.reason });
        return;
      }
      if (replayed.status === "error") {
        res.status(500).json({ status: "error", reason: replayed.reason });
        return;
      }
      row = await loadActiveSiteDrainageRow(engagementId);
    }
    if (!row) {
      res.status(500).json({ status: "error", reason: "Row missing after replay." });
      return;
    }
    res.status(200).json({
      status: "ok",
      materializableElementId: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      propertySet: row.propertySet,
    });
  },
);

router.get(
  "/engagements/:id/site-drainage/design-storms",
  async (req: Request, res: Response) => {
    const engagementId = typeof req.params.id === "string" ? req.params.id : "";
    if (!engagementId) {
      res.status(400).json({ error: "missing_engagement_id" });
      return;
    }
    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }
    const [engagement] = await db
      .select({
        latitude: engagementsTable.latitude,
        longitude: engagementsTable.longitude,
      })
      .from(engagementsTable)
      .where(eq(engagementsTable.id, engagementId))
      .limit(1);
    if (engagement?.latitude == null || engagement?.longitude == null) {
      res.status(422).json({
        status: "no-geocode",
        reason: "Engagement has no geocode — add a site address first.",
      });
      return;
    }
    const estimate = await fetchNoaaAtlas14PointEstimate({
      lat: Number(engagement.latitude),
      lng: Number(engagement.longitude),
    });
    res.status(200).json({ status: "ok", estimate });
  },
);

export default router;
