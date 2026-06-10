/**
 * Arrow two Phase 3 — calibration overlay (Cortex internal surface).
 * Rail-quiet: not in OpenAPI / MCP tool schemas (I7).
 *
 *   GET  /findings/calibration-overlay
 *   GET  /findings/calibration-overlay/health
 *   POST /findings/calibration/recompute
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  listOverlayRows,
  recomputeCalibrationOverlay,
  resolveOverlayCalibration,
  computeAttributionCoverage,
} from "@workspace/engine-core";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

router.get(
  "/findings/calibration-overlay",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const rawTenant = req.query.jurisdictionTenant;
      const jurisdictionTenant =
        typeof rawTenant === "string" && rawTenant.trim()
          ? rawTenant.trim()
          : null;
      const rawAtom = req.query.atomId;
      const atomIds =
        typeof rawAtom === "string" && rawAtom.trim()
          ? [rawAtom.trim()]
          : undefined;

      if (atomIds?.length === 1 && jurisdictionTenant) {
        const row = await resolveOverlayCalibration({
          atomId: atomIds[0]!,
          jurisdictionTenant,
        });
        res.json({ rows: row ? [row] : [] });
        return;
      }

      const rows = await listOverlayRows({ jurisdictionTenant, atomIds });
      res.json({ rows });
    } catch (err) {
      logger.error({ err }, "calibration overlay query failed");
      res.status(500).json({ error: "calibration_overlay_query_failed" });
    }
  },
);

router.get(
  "/findings/calibration-overlay/health",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const rawTenant = req.query.jurisdictionTenant;
      const jurisdictionTenant =
        typeof rawTenant === "string" && rawTenant.trim()
          ? rawTenant.trim()
          : null;
      const health = await computeAttributionCoverage({ jurisdictionTenant });
      res.json(health);
    } catch (err) {
      logger.error({ err }, "calibration attribution health failed");
      res.status(500).json({ error: "calibration_attribution_health_failed" });
    }
  },
);

router.post(
  "/findings/calibration/recompute",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const result = await recomputeCalibrationOverlay();
      res.json(result);
    } catch (err) {
      logger.error({ err }, "calibration recompute failed");
      res.status(500).json({ error: "calibration_recompute_failed" });
    }
  },
);

export default router;
