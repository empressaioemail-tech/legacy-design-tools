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
import {
  createRecordsRequestJob,
  listRecordsRequestJobsWire,
} from "../lib/recordsRequestService";
import {
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

    const result = await createRecordsRequestJob({
      engagementId,
      userId,
      parcelKey,
      countyFips,
      placeKey: placeKey ?? null,
      log,
    });
    res.status(result.status).json(result.body);
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

    const body = await listRecordsRequestJobsWire(engagementId, userId);
    res.status(200).json(body);
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
