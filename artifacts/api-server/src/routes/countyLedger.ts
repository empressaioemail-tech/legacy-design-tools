/**
 * County ledger endpoint, the performance public data layer (R-FND-6, OPS-6).
 *
 * L18 / P-14: default GET serves county_ledger_snapshot in constant time.
 * Freshness is part of the response (summary.computedAt + summary.servedAt).
 * The live compute path (facet scan + CROSS JOIN + COUNT DISTINCT capability
 * probes) is behind ?compute=live for audit only — never the default.
 *
 * SS-W7 / P-44 adds the WRITE side that was missing: POST /recompute. Before
 * it, the snapshot could only be refreshed by someone running
 * countyLedgerMaterializeCli --apply from a laptop, which is why the live
 * ledger sat materialized at 2026-08-14T17:41:22.500Z while the L26 effort
 * landed footprints in 174 counties on 2026-08-17 and the ledger still read
 * `footprint` as not-yet on all 254 cells. Decisions were being made against a
 * snapshot that predated the work.
 *
 * Contract: manifestCells shape, displayState semantics, and
 * applyDepthRailDisplayGate are unchanged; they run at materialize time.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db, withClusterSweepLock } from "@workspace/db";
import { COUNTY_LEDGER_SNAPSHOT_ID } from "@workspace/db/schema";
import { requireServiceToken } from "../middlewares/serviceAuth";
import {
  computeCountyLedgerPayload,
  diffCountyLedgerPayloads,
  readCountyLedgerSnapshot,
  stampServedPayload,
  applyDepthRailDisplayGate,
  applyDerivationIndeterminateOverlay,
  computeTexasRollup,
  type CountyLedgerPayload,
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

/**
 * Advisory-lock namespace for the recompute. ONE recompute at a time across
 * the whole cluster: the compute runs COUNT DISTINCT over cad_property and
 * txgio_parcel, and the standing rule is at most one heavy full-table scan at
 * a time on a shared database. A contender gets 409, never a second scan.
 */
export const COUNTY_LEDGER_RECOMPUTE_LOCK = "county_ledger_recompute";

/**
 * Statement timeout for the recompute transaction. Cloud Run cuts the request
 * at 300s (--timeout=300 in .github/workflows/cloud-run-deploy.yml), so the
 * database is given less than that and fails LOUDLY inside the request rather
 * than the client seeing a 504 while a write it cannot observe may or may not
 * still land.
 */
export const RECOMPUTE_STATEMENT_TIMEOUT_MS = 240_000;

function isLiveCompute(req: Request): boolean {
  const q = req.query.compute;
  const v = Array.isArray(q) ? q[0] : q;
  return v === "live";
}

function firstQueryValue(req: Request, key: string): string | undefined {
  const q = req.query[key];
  const v = Array.isArray(q) ? q[0] : q;
  return typeof v === "string" ? v : undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
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
          "GET /api/county-ledger has no snapshot. Run countyLedgerMaterializeCli --apply, or POST /api/county-ledger/recompute. Live compute is ?compute=live (audit only).",
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

/**
 * POST /api/county-ledger/recompute — recompute the ledger from source tables
 * and materialize it. Service token only: this is a heavy scan and a write.
 *
 * Query:
 *   dryRun=1     compute and diff, write nothing. The response then reports
 *                the store as UNMOVED, which is the point: it proves the
 *                freshness fields are read back from the store rather than
 *                echoed from the object just computed in memory.
 *   probe=skip   skip the COUNT DISTINCT rail-capability probes. Everything
 *                else in the compute is small; this is the escape hatch when
 *                the probes are what will not finish inside the request. The
 *                skip is stamped into the payload as
 *                railCapabilitiesProbeReason — an honest absence, never a
 *                stale value carried forward.
 *
 * NEVER LET A RE-READ MASQUERADE AS A RECOMPUTE. Three separate things are
 * reported and they are not interchangeable:
 *
 *   computedAt              the stamp on the payload just computed. It moves
 *                           on EVERY call by construction, so on its own it
 *                           proves a job ran and nothing more.
 *   store.computedAtBefore  read from county_ledger_snapshot BEFORE the write.
 *   store.computedAtAfter   read back from county_ledger_snapshot AFTER the
 *                           transaction committed, on a fresh read. A write
 *                           that did not land is a defect, not a success, and
 *                           it answers 500 (`recompute_not_persisted`) — the
 *                           verify checks the STORE, never the in-memory
 *                           object it just built.
 *   delta                   what actually MOVED, per rail. An all-zero delta
 *                           means the ledger was already current; that is a
 *                           result, not a failure, and it is reported as such.
 *
 * PROBING NOTE. This route takes no body, but a bare `curl -X POST` with no
 * body is rejected by the Cloud Run frontend with 411 Length Required before
 * Express ever sees it. 411 says nothing about whether the route exists —
 * probe with `-d '{}'`.
 */
router.post(
  "/recompute",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const dryRun = isTruthyFlag(firstQueryValue(req, "dryRun"));
    const probeParam = firstQueryValue(req, "probe");
    if (probeParam !== undefined && probeParam !== "full" && probeParam !== "skip") {
      res.status(400).json({
        error: "invalid_probe",
        message: "probe must be 'full' (default) or 'skip'",
      });
      return;
    }
    const probeCapabilities = probeParam !== "skip";

    try {
      const handle = db as unknown as SelectDb;
      const outcome = await withClusterSweepLock(
        db,
        COUNTY_LEDGER_RECOMPUTE_LOCK,
        async (tx) => {
          await tx.execute(
            sql.raw(
              "SET LOCAL statement_timeout = " +
                String(RECOMPUTE_STATEMENT_TIMEOUT_MS),
            ),
          );
          const txHandle = tx as unknown as SelectDb;
          const before = await readCountyLedgerSnapshot(txHandle);
          const computedAt = new Date();
          const payload = await computeCountyLedgerPayload(txHandle, {
            probeCapabilities,
          });
          if (!dryRun) {
            await tx.execute(sql`
              INSERT INTO county_ledger_snapshot (id, computed_at, payload)
              VALUES (${COUNTY_LEDGER_SNAPSHOT_ID}, ${computedAt.toISOString()}, ${JSON.stringify(payload)}::jsonb)
              ON CONFLICT (id) DO UPDATE
                SET computed_at = EXCLUDED.computed_at,
                    payload = EXCLUDED.payload
            `);
          }
          return {
            computedAt,
            payload,
            beforeComputedAt: before?.computedAt ?? null,
            beforePayload: before?.payload ?? null,
          };
        },
      );

      if (!outcome.acquired) {
        res.status(409).json({
          error: "recompute_in_progress",
          message:
            "another county-ledger recompute holds the cluster advisory lock; at most one heavy scan runs at a time",
        });
        return;
      }

      const { computedAt, payload, beforeComputedAt, beforePayload } =
        outcome.result;

      // Fresh read AFTER the transaction committed. This is the whole verify:
      // a writer that checks the object it just built in memory can never
      // report a lost write.
      const readback = await readCountyLedgerSnapshot(handle);
      const storeComputedAtAfter = readback?.computedAt.toISOString() ?? null;
      const storeComputedAtBefore = beforeComputedAt?.toISOString() ?? null;
      const persistedAsComputed =
        storeComputedAtAfter === computedAt.toISOString();

      if (!dryRun && !persistedAsComputed) {
        res.status(500).json({
          error: "recompute_not_persisted",
          message:
            "the recompute produced a payload but the store does not carry its computedAt; the write did not land and this is NOT a successful recompute",
          computedAt: computedAt.toISOString(),
          store: {
            computedAtBefore: storeComputedAtBefore,
            computedAtAfter: storeComputedAtAfter,
          },
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const delta = diffCountyLedgerPayloads(beforePayload, payload);
      res.json({
        ok: true,
        applied: !dryRun,
        dryRun,
        probe: probeCapabilities ? "full" : "skip",
        computedAt: computedAt.toISOString(),
        durationMs: Date.now() - startedAt,
        store: {
          computedAtBefore: storeComputedAtBefore,
          computedAtAfter: storeComputedAtAfter,
          /** Measured from the STORE on both sides, not from the payload. */
          computedAtMovedInStore: storeComputedAtAfter !== storeComputedAtBefore,
          persistedAsComputed,
          stalenessBeforeMs:
            beforeComputedAt === null
              ? null
              : computedAt.getTime() - beforeComputedAt.getTime(),
        },
        delta,
        summary: payload.summary,
        railCapabilitiesProbeReason: payload.railCapabilitiesProbeReason ?? null,
        note: "computedAt moves on every call by construction — it proves a job ran, nothing more. `delta` is what actually moved; an all-zero delta means the ledger was already current. Under dryRun the store is deliberately left unmoved.",
      });
    } catch (err) {
      res.status(500).json({
        error: "county_ledger_recompute_failed",
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
    }
  },
);

/**
 * `/refresh` is NOT a second name for the recompute.
 *
 * Two names for one action is how two callers end up graded against
 * different contracts, so this path is a named tombstone rather than an
 * alias. It exists at all because unmatched GET /api/* falls through to the
 * SPA catch-all and answers HTTP 200 text/html, which a caller reads as
 * "served" — the same fallthrough that made the missing sweep route look
 * like a data problem for a day.
 */
router.all("/refresh", (_req: Request, res: Response) => {
  res.status(404).json({
    error: "no_such_route",
    message:
      "/api/county-ledger/refresh does not exist. Recompute and materialize with POST /api/county-ledger/recompute (service token). Re-reading the existing snapshot is GET /api/county-ledger.",
  });
});

export { router as countyLedgerRouter };
export type { CountyLedgerPayload };
