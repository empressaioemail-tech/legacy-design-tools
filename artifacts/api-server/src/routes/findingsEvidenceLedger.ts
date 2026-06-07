/**
 * Arrow two Phase 1 — tier 1a adjudication-to-atom evidence ledger.
 *
 * Internal read-model only (not in OpenAPI). Reviewer audience gate
 * mirrors the Compliance Engine console routes in `findingsRuns.ts`.
 *
 *   GET /findings/adjudication-evidence — per-atom adjudication tallies
 *   GET /findings/adjudication-evidence/health — invalidCitationCount rate
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { logger } from "../lib/logger";
import {
  buildAtomAdjudicationEvidenceLedger,
  computeInvalidCitationHealth,
} from "../lib/atomAdjudicationEvidenceLedger";

const router: IRouter = Router();

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

router.get(
  "/findings/adjudication-evidence",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const rawTenant = req.query.jurisdictionTenant;
      const jurisdictionTenant =
        typeof rawTenant === "string" && rawTenant.trim()
          ? rawTenant.trim()
          : null;

      const ledger = await buildAtomAdjudicationEvidenceLedger({
        jurisdictionTenant,
      });
      res.json(ledger);
    } catch (err) {
      logger.error({ err }, "adjudication evidence ledger query failed");
      res.status(500).json({ error: "adjudication_evidence_ledger_failed" });
    }
  },
);

router.get(
  "/findings/adjudication-evidence/health",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const health = await computeInvalidCitationHealth();
      res.json(health);
    } catch (err) {
      logger.error({ err }, "adjudication evidence health query failed");
      res.status(500).json({ error: "adjudication_evidence_health_failed" });
    }
  },
);

export default router;
