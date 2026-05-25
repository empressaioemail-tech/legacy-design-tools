/**
 * /api/substrate/* — the live Hauska substrate catalog.
 *
 * QA-17: the Code Library listed only the two jurisdictions with a
 * cortex-prod-local `code_atoms` corpus (Grand County, Bastrop) because
 * it has never been wired to the Hauska substrate. This route is the
 * net-new read path — cortex-api consuming the Hauska MCP server's
 * `list_jurisdictions` tool — that lets the Code Library show every
 * ingested jurisdiction. Distinct from `/api/codes/*`, which stays the
 * cortex-prod-local corpus + warmup surface.
 *
 * Read-only and ungated, mirroring `GET /api/codes/jurisdictions`. The
 * per-tier `accessPolicy` visibility partition is enforced upstream at
 * the MCP server by the product key cortex-api authenticates with — not
 * by a Cortex session audience. See `lib/hauskaSubstrateClient.ts`.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  getHauskaSubstrateClient,
  getSubstrateHealthSnapshot,
  SubstrateError,
} from "../lib/hauskaSubstrateClient";
import { logger } from "../lib/logger";
import { filterSubstrateCatalog } from "./substrateFilter";

const router: IRouter = Router();

router.get("/substrate/health", (_req: Request, res: Response): void => {
  res.json(getSubstrateHealthSnapshot());
});

router.get(
  "/substrate/jurisdictions",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const catalog = await getHauskaSubstrateClient().listJurisdictions();
      const filtered = filterSubstrateCatalog(catalog, {
        states:
          typeof req.query.states === "string" ? req.query.states : undefined,
        keys: typeof req.query.keys === "string" ? req.query.keys : undefined,
        q: typeof req.query.q === "string" ? req.query.q : undefined,
      });
      res.json(filtered);
    } catch (err) {
      if (err instanceof SubstrateError) {
        // The substrate (or its key/URL config) is the problem, not the
        // request — 502, with the coarse code so the UI can branch.
        logger.warn(
          { err, code: err.code },
          "substrate jurisdictions fetch failed",
        );
        res.status(502).json({
          error: "substrate_unavailable",
          code: err.code,
          detail: err.message,
        });
        return;
      }
      logger.error({ err }, "substrate jurisdictions: unexpected failure");
      res
        .status(500)
        .json({ error: "Failed to list substrate jurisdictions" });
    }
  },
);

export default router;
