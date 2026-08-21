/**
 * POST /api/county-ledger/score — trigger a rail scoring run (SS-W12 / P-47).
 *
 * WHY A ROUTE AND NOT ONLY A CLI. SS-W7's PR #437 names the disease exactly:
 * before its recompute route, "the only way to refresh the manifest was for
 * someone to run a CLI by hand". Shipping this capability as a CLI alone
 * would reproduce that. The two routes are the two legs of the same pipe and
 * they compose:
 *
 *   POST /api/county-ledger/score      WRITTEN -> SCORED
 *       source tables -> county_facet_coverage
 *   POST /api/county-ledger/recompute  SCORED  -> SERVED   (SS-W7, PR #437)
 *       county_facet_coverage -> county_ledger_snapshot
 *
 * A recompute alone moves nothing when no scorer ever ran — which is exactly
 * what SS-W7 verified for the `footprint` rail: the snapshot was four days
 * stale AND a recompute would move zero of 3,556 cells, because
 * `county_facet_coverage` holds zero footprint rows. Staleness was real and
 * irrelevant; the missing leg was this one.
 *
 * FILE OWNERSHIP. This is a separate router mounted at the SAME
 * `/county-ledger` prefix rather than a handler added to `countyLedger.ts`,
 * because PR #437 is open against that file. Express tries mounted routers in
 * order, so `POST /score` falls through the ledger router (which has no
 * matching handler) and lands here. Same prefix, same auth, same lock
 * discipline, same dryRun semantics — a sibling, not a second entry point —
 * with no merge conflict against a lane still in flight.
 *
 * PROBING NOTE, inherited from #437 and worth repeating because it has cost
 * real time: a bodyless `curl -X POST` is rejected by the Cloud Run frontend
 * with `411 Length Required` before Express sees it. A 411 says nothing about
 * whether this route exists. Probe with `-d '{}'`.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, pool, withClusterSweepLock } from "@workspace/db";

import { requireServiceToken } from "../middlewares/serviceAuth";
import {
  runRailScore,
  scoreableRailKeys,
  unspecifiedRails,
  type MeasureContext,
  type RailScoreQueryable,
} from "../lib/railScoring";

/**
 * ONE scoring run at a time across the cluster. A run reads `atoms` and
 * `txgio_parcel` and writes the ledger; the standing rule is at most one
 * heavy scan at a time on a shared database (AGENT_CONTRACT section 4). A
 * contender gets 409, never a second scan.
 *
 * A DIFFERENT namespace from `county_ledger_recompute`: the two legs are
 * independent and serialising them against each other would make a scoring
 * run and a materialize block one another for no reason.
 */
export const COUNTY_RAIL_SCORE_LOCK = "county_rail_score";

/** Cloud Run cuts the request at 300s, so the database gives up first and LOUDLY. */
export const RAIL_SCORE_STATEMENT_TIMEOUT_MS = 240_000;

export const countyRailScoreRouter: IRouter = Router();

function firstQueryValue(req: Request, key: string): string | undefined {
  const q = req.query[key];
  const v = Array.isArray(q) ? q[0] : q;
  return typeof v === "string" ? v : undefined;
}

function listQueryValues(req: Request, key: string): string[] {
  const q = req.query[key];
  const raw = Array.isArray(q) ? q : q === undefined ? [] : [q];
  return raw
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

/**
 * GET /api/county-ledger/score/registry — what is scoreable and what is not.
 *
 * Anonymous, like the ledger read next door. A rail with no measurement spec
 * is a first-class, readable state carrying its reason and its owner, rather
 * than a gap someone has to infer from a grid full of `not-yet`.
 */
countyRailScoreRouter.get("/score/registry", (_req: Request, res: Response) => {
  res.json({
    scoreable: scoreableRailKeys(),
    unspecified: unspecifiedRails(),
    servedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/county-ledger/score — run the scorer. Service token: heavy read
 * plus a ledger write.
 *
 * Query:
 *   rail=<key>     repeatable, or comma-separated. Default: every rail that
 *                  has a measurement spec.
 *   county=<fips>  repeatable, or comma-separated. Default: every county in
 *                  `county_manifest`.
 *   dryRun=1       measure and diff, write nothing. The report still names
 *                  every cell a real run would move.
 *   cells=1        include per-cell numerators, denominators and states, so a
 *                  dry run can be reviewed rather than trusted. Capped at a
 *                  small target set; past the cap the report says the cells
 *                  were omitted and why.
 *   reassessAbsences=1
 *                  allow a rail to overturn a stored `satisfied-absent` it has
 *                  no probe to reassess. OFF by default: an absence in the
 *                  ledger came from a positive determination, and a scorer
 *                  that cannot see the source cannot honestly contradict it.
 *
 * Two things this route will never do, both of them named in the response
 * rather than hidden:
 *
 *   - Score a rail it cannot measure. A rail with no measurement spec, or an
 *     atom-count rail with no ATOMS store configured, comes back under
 *     `railsUnavailable` with a reason. It is NEVER scored as zero coverage,
 *     because zero coverage is a claim about Texas and a missing connection
 *     string is a claim about this process.
 *   - Report a re-run as work. `cellsChanged` compares stored VALUES, not row
 *     counts, so a second run over unchanged sources reports zero changed
 *     even though every row's `checked_at` moved.
 */
countyRailScoreRouter.post(
  "/score",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const dryRun = isTruthyFlag(firstQueryValue(req, "dryRun"));
    const railKeys = listQueryValues(req, "rail");
    const countyFips = listQueryValues(req, "county");

    const badCounty = countyFips.find((c) => !/^\d{5}$/.test(c));
    if (badCounty !== undefined) {
      res.status(400).json({
        error: "invalid_county_fips",
        message: `county must be a 5-digit FIPS; got '${badCounty}'`,
      });
      return;
    }

    // The ATOMS store is a SEPARATE database from the deployment store. When
    // it is not configured the run does not fail and does not silently skip:
    // every atom-count rail is reported unavailable with reason
    // `atoms_store_not_configured`, so the response itself says what to wire.
    const atomsUrl = process.env.ATOMS_DATABASE_URL?.trim();
    const atomsPool = atomsUrl
      ? new pg.Pool({
          connectionString: atomsUrl,
          ssl: atomsUrl.includes("sslmode=")
            ? undefined
            : { rejectUnauthorized: false },
          max: 2,
        })
      : null;

    try {
      const outcome = await withClusterSweepLock(
        db,
        COUNTY_RAIL_SCORE_LOCK,
        async (tx) => {
          await tx.execute(
            sql.raw(
              "SET LOCAL statement_timeout = " +
                String(RAIL_SCORE_STATEMENT_TIMEOUT_MS),
            ),
          );
          // The advisory lock is transaction-scoped on the drizzle handle and
          // is held for the duration of the run; the measurement itself uses
          // the shared pg pool, whose parameterized `$1` surface the
          // measurers are written against.
          const ctx: MeasureContext = {
            deployment: pool as unknown as RailScoreQueryable,
            atoms: atomsPool as unknown as RailScoreQueryable | null,
          };
          return await runRailScore(ctx, {
            railKeys: railKeys.length > 0 ? railKeys : undefined,
            countyFips: countyFips.length > 0 ? countyFips : undefined,
            dryRun,
            includeCells: isTruthyFlag(firstQueryValue(req, "cells")),
            reassessAbsences: isTruthyFlag(
              firstQueryValue(req, "reassessAbsences"),
            ),
          });
        },
      );

      if (!outcome.acquired) {
        res.status(409).json({
          error: "score_in_progress",
          message:
            "another rail scoring run holds the cluster advisory lock; at most one runs at a time",
        });
        return;
      }

      const report = outcome.result;

      // A dry run that reported writes would mean the flag is decorative.
      // Fail loudly rather than answer 200 with a false claim.
      if (dryRun && report.totals.cellsWritten !== 0) {
        res.status(500).json({
          error: "dry_run_wrote",
          message: `a dry run reported ${report.totals.cellsWritten} ledger writes`,
          report,
        });
        return;
      }

      res.json({
        ok: true,
        applied: !dryRun,
        // TWO durations, deliberately distinct: this one includes acquiring
        // the advisory lock and opening the atoms pool, `durationMs` inside
        // the report is the run itself. Collapsing them would hide lock wait.
        routeDurationMs: Date.now() - startedAt,
        ...report,
        nextStep:
          "county_facet_coverage is now current for the rails listed above. The SERVED grid still reads county_ledger_snapshot: POST /api/county-ledger/recompute to materialize it.",
      });
    } catch (err) {
      res.status(500).json({
        error: "rail_score_failed",
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      if (atomsPool) await atomsPool.end();
    }
  },
);

export default countyRailScoreRouter;
