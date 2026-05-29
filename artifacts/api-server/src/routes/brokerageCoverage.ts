/**
 * GET /api/brokerage/v1/coverage — Central TX pilot honesty manifest (public).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { buildBrokeragePilotCoverageBody } from "../lib/brokeragePilotCoverage";
import type { PilotCoverageTier } from "@workspace/codes";

const router: IRouter = Router();

/** Map internal tier to 75b status vocabulary. */
export function coverageStatusFor75b(tier: PilotCoverageTier): string {
  if (tier === "blocked_partnership") return "blocked";
  return tier;
}

router.get("/", async (_req: Request, res: Response) => {
  const body = await buildBrokeragePilotCoverageBody();
  res.json({
    ...body,
    jurisdictions: body.jurisdictions.map((j) => ({
      ...j,
      status: coverageStatusFor75b(j.tier as PilotCoverageTier),
    })),
  });
});

export { router as brokerageCoverageRouter };
