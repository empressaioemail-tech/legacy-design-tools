/**
 * County ledger endpoint, the performance public data layer (R-FND-6, OPS-6).
 *
 * L18 / P-14: default GET serves county_ledger_snapshot in constant time.
 * Freshness is part of the response (summary.computedAt + summary.servedAt).
 * The live compute path (facet scan + CROSS JOIN + COUNT DISTINCT capability
 * probes) is behind ?compute=live for audit only — never the default.
 *
 * Contract: manifestCells shape, displayState semantics, and
 * applyDepthRailDisplayGate are unchanged; they run at materialize time.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  computeCountyLedgerPayload,
  readCountyLedgerSnapshot,
  stampServedPayload,
  applyDepthRailDisplayGate,
  applyDerivationIndeterminateOverlay,
  computeTexasRollup,
  type ManifestCell,
  type RollupResult,
  type SelectDb,
} from "../countyLedgerCompute";

const router: IRouter = Router();

export type { ManifestCell, RollupResult };
export {
  applyDepthRailDisplayGate,
  applyDerivationIndeterminateOverlay,
  computeTexasRollup,
};

function isLiveCompute(req: Request): boolean {
  const q = req.query.compute;
  const v = Array.isArray(q) ? q[0] : q;
  return v === "live";
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const handle = db as unknown as SelectDb;
    if (isLiveCompute(req)) {
      const payload = await computeCountyLedgerPayload(handle);
      const now = new Date();
      res.json(stampServedPayload(payload, now, now));
      return;
    }

    const snap = await readCountyLedgerSnapshot(handle);
    if (!snap) {
      res.status(503).json({
        error: "county_ledger_not_materialized",
        message:
          "GET /api/county-ledger has no snapshot. Run countyLedgerMaterializeCli --apply. Live compute is ?compute=live (audit only).",
        servedAt: new Date().toISOString(),
      });
      return;
    }

    res.json(stampServedPayload(snap.payload, snap.computedAt, new Date()));
  } catch (err) {
    res.status(500).json({
      error: "county_ledger_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as countyLedgerRouter };
