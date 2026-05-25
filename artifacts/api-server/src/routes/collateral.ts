/**
 * Placid collateral export — templates, assets, async PDF jobs, signed fetch.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, engagements } from "@workspace/db";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";
import { COLLATERAL_TEMPLATE_PACKS, estimateCreditsForRequest, templatePackById } from "../lib/collateral/catalog";
import { listEngagementCollateralAssets } from "../lib/collateral/assets";
import { assetKeysForJob, streamCollateralAsset } from "../lib/collateral/assetStream";
import { isPlacidConfigured } from "../lib/collateral/config";
import {
  isSigningConfigured,
  verifyCollateralAssetToken,
} from "../lib/collateral/exportSignedUrl";
import { runCollateralExportJob } from "../lib/collateral/exportWorker";
import {
  createExportJob,
  getExportJobRow,
  listCollateralExports,
  toExportJobWire,
} from "../lib/collateral/store";
import type { CollateralExportRequest } from "../lib/collateral/wireTypes";

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function requestBaseUrl(req: Request): string {
  const proto = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.get("host") ?? "localhost:8080";
  return `${proto}://${host}`;
}

const authed = Router();
authed.use(requireServiceTokenOrSession);

/** Public signed asset fetch for Placid (no session). */
router.get(
  "/collateral/fetch/:token/:assetKey",
  async (req: Request, res: Response) => {
    const token = routeParam(req.params.token);
    const assetKey = decodeURIComponent(routeParam(req.params.assetKey));
    if (!token || !assetKey) {
      res.status(400).json({ error: "invalid_fetch" });
      return;
    }
    let payload;
    try {
      if (!isSigningConfigured()) {
        res.status(503).json({ error: "signing_not_configured" });
        return;
      }
      payload = verifyCollateralAssetToken(token, assetKey);
    } catch {
      res.status(503).json({ error: "signing_not_configured" });
      return;
    }
    if (!payload) {
      res.status(403).json({ error: "invalid_or_expired_token" });
      return;
    }
    const job = await getExportJobRow(payload.jobId);
    if (!job) {
      res.status(403).json({ error: "job_not_found" });
      return;
    }
    const allowed = assetKeysForJob(job.request);
    if (!allowed.has(assetKey)) {
      res.status(403).json({ error: "asset_not_in_job" });
      return;
    }
    const ok = await streamCollateralAsset(assetKey, res);
    if (!ok && !res.headersSent) {
      res.status(404).json({ error: "asset_not_found" });
    }
  },
);

authed.get("/collateral/templates", (_req: Request, res: Response) => {
  res.json(COLLATERAL_TEMPLATE_PACKS);
});

authed.get(
  "/engagements/:engagementId/collateral/assets",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const assets = await listEngagementCollateralAssets(
        engagementId,
        requestBaseUrl(req),
      );
      if (assets === null) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(assets);
    } catch (err) {
      logger.error({ err, engagementId }, "collateral assets failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.get(
  "/engagements/:engagementId/collateral/exports",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [eng] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const exports = await listCollateralExports(engagementId);
    res.json(exports);
  },
);

authed.post(
  "/engagements/:engagementId/collateral/export",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [eng] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const body = req.body as CollateralExportRequest;
    if (!body?.templatePackId || !Array.isArray(body.assetIds)) {
      res.status(400).json({ error: "Invalid export request" });
      return;
    }
    if (!templatePackById(body.templatePackId)) {
      res.status(400).json({ error: "Unknown template pack" });
      return;
    }
    if (!isSigningConfigured()) {
      res.status(503).json({
        error: "Collateral signing secret not configured (COLLATERAL_SIGNING_SECRET)",
      });
      return;
    }
    const sheetIds =
      body.sheetAssetIds ??
      body.assetIds.filter((id) => id.startsWith("sheet:"));
    const creditsEstimated = estimateCreditsForRequest({
      sheetPageCount: sheetIds.length,
    });
    try {
      const jobId = await createExportJob({
        engagementId,
        tenantId: req.session.tenantId,
        request: {
          templatePackId: body.templatePackId,
          assetIds: body.assetIds,
          slotMapping: body.slotMapping ?? {},
          textFields: body.textFields ?? {},
          sheetAssetIds: sheetIds,
        },
        creditsEstimated,
      });
      runCollateralExportJob({
        jobId,
        tenantId: req.session.tenantId,
        baseUrl: requestBaseUrl(req),
      });
      res.status(202).json({
        jobId,
        creditsEstimated,
        placidConfigured: isPlacidConfigured(),
      });
    } catch (err) {
      logger.error({ err, engagementId }, "collateral export start failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.get("/collateral/export-jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = routeParam(req.params.jobId);
  if (!UUID_RE.test(jobId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const row = await getExportJobRow(jobId);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(toExportJobWire(row));
});

router.use(authed);

export default router;
