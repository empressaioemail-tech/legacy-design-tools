/**
 * P-85 WDLL item 4 — Records Request job routes (terrainJobWorker pattern).
 *
 *   POST /api/engagements/:id/records-request — create job (portal gate + live GIS)
 *   GET  /api/engagements/:id/records-request — list jobs for engagement/user
 *   GET  /api/engagements/:id/records-request/:jobId — job status
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { requireGateEngineServiceAuth } from "../middlewares/gateEngineServiceAuth";
import { verifyGateContext } from "../middlewares/gateContextVerification";
import { assertEngagementServiceTenantScope } from "../lib/gateFrontSeamEngagement";
import { resolvePeOwnerUserId } from "../lib/peEntitlement";
import { isP85CountyFips } from "../lib/p85ClerkPortalRegistry";
import { assertCountyPortalsAllowAutomatedSearch } from "../lib/clerkPortalSearchGate";
import { queryLiveEasementGisForParcel } from "../lib/liveEasementGisQuery";
import { resolveParcelInput } from "../lib/siteTopographyIngest";
import {
  enqueueRecordsRequestJob,
  listRecordsRequestJobsForEngagement,
  loadRecordsRequestJobById,
  recordsRequestJobToWire,
} from "../lib/recordsRequestJobWorker";

const router: IRouter = Router();

router.use(requireGateEngineServiceAuth);
router.use(verifyGateContext);

const ENGAGEMENT_PARAMS = z.object({ id: z.string().uuid() });
const JOB_PARAMS = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
});

const CREATE_BODY_SCHEMA = z
  .object({
    parcelKey: z.string().min(1),
    countyFips: z.string().regex(/^\d{5}$/),
    placeKey: z.string().min(1).optional(),
  })
  .strict();

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

function resolveRequestUserId(req: Request): string | null {
  return resolvePeOwnerUserId(req);
}

function parcelKeyCountyFips(parcelKey: string): string | null {
  if (!parcelKey.startsWith("apn:")) return null;
  const parts = parcelKey.split(":");
  const fips = parts[1]?.trim();
  return fips && /^\d{5}$/.test(fips) ? fips : null;
}

router.post(
  "/engagements/:id/records-request",
  async (req: Request, res: Response) => {
    const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    const bodyParse = CREATE_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParse.error.issues,
      });
      return;
    }

    const userId = resolveRequestUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
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

    const { parcelKey, countyFips, placeKey } = bodyParse.data;

    if (!isP85CountyFips(countyFips)) {
      res.status(422).json({
        error: "county_out_of_scope",
        countyFips,
        message: "Records Request is limited to the six P-85 Central Texas counties",
      });
      return;
    }

    const keyCounty = parcelKeyCountyFips(parcelKey);
    if (keyCounty && keyCounty !== countyFips) {
      res.status(422).json({
        error: "parcel_key_county_mismatch",
        parcelKey,
        countyFips,
        keyCounty,
      });
      return;
    }

    const portalGate = await assertCountyPortalsAllowAutomatedSearch(countyFips);
    if (!portalGate.ok) {
      res.status(403).json({
        error: "portal_automated_search_refused",
        code: portalGate.code,
        portalId: portalGate.portalId,
        message: portalGate.message,
      });
      return;
    }

    const parcel = await resolveParcelInput(engagementId);
    if (!parcel?.geometry) {
      res.status(422).json({
        error: "no_parcel_geometry",
        message:
          "Engagement has no derivable parcel polygon; run Generate Layers first",
      });
      return;
    }

    let liveInstantGis;
    try {
      liveInstantGis = await queryLiveEasementGisForParcel({
        parcelKey,
        countyFips,
        parcelGeometryGeojson: parcel.geometry,
      });
    } catch (err) {
      log.error(
        { err, engagementId, parcelKey, countyFips },
        "records request: live GIS query failed",
      );
      res.status(502).json({
        error: "live_gis_query_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let enqueued: Awaited<ReturnType<typeof enqueueRecordsRequestJob>>;
    try {
      enqueued = await enqueueRecordsRequestJob({
        engagementId,
        userId,
        userEmail: null,
        parcelKey,
        countyFips,
        placeKey: placeKey ?? null,
        liveInstantGis,
        requestPayload: {
          parcelOrigin: parcel.origin,
          briefingSourceId: parcel.briefingSourceId,
          layerKind: parcel.layerKind,
        },
        log,
      });
    } catch (err) {
      log.error(
        { err, engagementId, parcelKey, countyFips },
        "records request: enqueue failed",
      );
      res.status(500).json({
        error: "internal_worker_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    res.status(202).json({
      status: enqueued.alreadyInFlight ? "in-progress" : "accepted",
      jobId: enqueued.jobId,
      jobStatus: enqueued.alreadyInFlight ? "running" : "queued",
      liveInstantGis,
    });
  },
);

router.get(
  "/engagements/:id/records-request",
  async (req: Request, res: Response) => {
    const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    const userId = resolveRequestUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
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

    const jobs = await listRecordsRequestJobsForEngagement(engagementId, userId);
    res.status(200).json({
      jobs: jobs.map(recordsRequestJobToWire),
    });
  },
);

router.get(
  "/engagements/:id/records-request/:jobId",
  async (req: Request, res: Response) => {
    const paramsParse = JOB_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const { id: engagementId, jobId } = paramsParse.data;

    const userId = resolveRequestUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
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

    const job = await loadRecordsRequestJobById(jobId);
    if (!job || job.engagementId !== engagementId || job.userId !== userId) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }

    res.status(200).json({
      job: recordsRequestJobToWire(job),
    });
  },
);

export default router;
