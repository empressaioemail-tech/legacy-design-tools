/**
 * Arrow two Phase 2 — outcome-observation capture routes (internal + gate service).
 *
 *   POST /api/findings/:findingId/outcome
 *   GET  /api/findings/outcome-observations
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { requireGateEngineServiceAuth } from "../middlewares/gateEngineServiceAuth";
import { verifyGateContext } from "../middlewares/gateContextVerification";
import {
  RecordFindingOutcomeBody,
  handleRecordFindingOutcome,
  listFindingOutcomeObservations,
} from "../lib/findingOutcomeObservation";

const router: IRouter = Router();

router.use(requireGateEngineServiceAuth);
router.use(verifyGateContext);

function requireOutcomeCaptureAudience(req: Request, res: Response): boolean {
  if (req.serviceAuth) return false;
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

const FINDING_ID_PARAMS = z.object({
  findingId: z.string().min(1),
});

router.post(
  "/findings/:findingId/outcome",
  async (req: Request, res: Response): Promise<void> => {
    if (requireOutcomeCaptureAudience(req, res)) return;

    const params = FINDING_ID_PARAMS.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_finding_id" });
      return;
    }
    const body = RecordFindingOutcomeBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_outcome_body" });
      return;
    }

    const result = await handleRecordFindingOutcome(
      req,
      params.data.findingId,
      body.data,
    );
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    res.status(201).json({
      eventId: result.eventId,
      findingAtomId: params.data.findingId,
      jurisdictionTenant: result.jurisdictionTenant,
      outcomeKind: body.data.outcomeKind,
    });
  },
);

router.get(
  "/findings/outcome-observations",
  async (req: Request, res: Response): Promise<void> => {
    if (requireOutcomeCaptureAudience(req, res)) return;

    const rawTenant = req.query.jurisdictionTenant;
    const rawFinding = req.query.findingAtomId;
    const jurisdictionTenant =
      typeof rawTenant === "string" && rawTenant.trim()
        ? rawTenant.trim()
        : null;
    const findingAtomId =
      typeof rawFinding === "string" && rawFinding.trim()
        ? rawFinding.trim()
        : null;

    const observations = await listFindingOutcomeObservations({
      jurisdictionTenant,
      findingAtomId,
    });
    res.json(observations);
  },
);

export default router;
