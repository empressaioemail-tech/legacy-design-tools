/**
 * GET /api/brokerage/v1/coverage — Central TX pilot honesty manifest.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { buildBrokeragePilotCoverageBody } from "../lib/brokeragePilotCoverage";

const router: IRouter = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await buildBrokeragePilotCoverageBody());
});

export { router as brokerageCoverageRouter };
