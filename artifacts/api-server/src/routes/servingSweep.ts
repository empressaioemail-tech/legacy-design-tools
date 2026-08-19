/**
 * Statewide serving sweep endpoint (SS-W7 / P-44).
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT. The County Manifest
 * (GET /api/county-ledger) answers "did a writer run for this county". This
 * answers a different question: "what does Smart Site actually SERVE a human,
 * for every parcel in this county". The two live side by side in Command
 * Center precisely because they disagree, and the disagreement is the finding.
 * Nothing here reconciles them.
 *
 * WHY THIS ROUTE EXISTS. Command Center shipped a serving-sweep panel that
 * probes GET /api/serving-sweep; lane P-43 shipped a sweep runner that emits
 * the frozen record. Neither side was wrong and nothing joined them: the probe
 * hit the SPA catch-all and answered HTTP 200 text/html, which the console
 * correctly refused to read as JSON. This is the pipe.
 *
 * SHAPE. The record is FROZEN at doc_repo
 * `_catalog/parcel_fact_sheet_contract/serving-sweep.ts`. The bodies served by
 * GET / and GET /:countyFips carry that shape and nothing else — no extra
 * keys, no envelope. Read-time metadata that would otherwise tempt an
 * addition (when the envelope was assembled, how many counties it carries)
 * rides in response headers instead, where it cannot break a consumer that
 * validates the frozen record strictly.
 *
 * FRESHNESS. There is no statewide row in the store. The envelope is
 * ASSEMBLED from whatever county rows exist, so `countiesSwept` is measured
 * from the array actually being served, and its `sweptAt` is the most recent
 * county sweep in it — never the read time, which would make a months-old
 * assembly look fresh.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, servingSweepCounty } from "@workspace/db";
import { requireServiceToken } from "../middlewares/serviceAuth";
import {
  assembleStatewideSweep,
  parseServingSweepIngestBody,
  type CountyServingSweep,
} from "../servingSweepRecord";

const router: IRouter = Router();

const COUNTY_FIPS_PATTERN = /^\d{5}$/;

interface StoredRow {
  countyFips: string;
  countyName: string;
  sweptAt: Date;
  resolverVersion: string;
  parcelsTotal: number;
  payload: unknown;
  ingestedAt: Date;
}

/**
 * GET /api/serving-sweep — the assembled StatewideServingSweep.
 *
 * 503 with a named reason when nothing has been ingested. An empty envelope
 * would be indistinguishable from a swept-and-found-nothing state, and an
 * empty result is not an absence.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = (await db.select().from(servingSweepCounty)) as StoredRow[];
    if (rows.length === 0) {
      res.status(503).json({
        error: "serving_sweep_not_ingested",
        message:
          "GET /api/serving-sweep has no county sweeps. A producer posts them to POST /api/serving-sweep/ingest (service token). This is an absence of ingest, not a sweep that found nothing.",
        servedAt: new Date().toISOString(),
      });
      return;
    }
    const sweep = assembleStatewideSweep(
      rows.map((r) => ({
        countyFips: r.countyFips,
        payload: r.payload as CountyServingSweep,
      })),
    );
    // Read-time metadata rides headers so the JSON body stays exactly the
    // frozen record. X-Sweep-Assembled-At is the read clock and is NEVER
    // the body's sweptAt.
    res.setHeader("X-Sweep-Assembled-At", new Date().toISOString());
    res.setHeader("X-Sweep-Counties-Swept", String(sweep.countiesSwept));
    res.setHeader("X-Sweep-Swept-At", sweep.sweptAt);
    res.json(sweep);
  } catch (err) {
    res.status(500).json({
      error: "serving_sweep_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/serving-sweep/counties — the per-county index.
 *
 * Additive, NOT part of the frozen record, and named so: it exists so a
 * caller can ask "which counties have been swept, and how fresh is each one"
 * without pulling the full statewide body. `ingestedAt` is reported next to
 * `sweptAt` because they are different facts and a stale ingest of a fresh
 * sweep (or the reverse) is exactly the kind of thing this program keeps
 * finding.
 *
 * Registered BEFORE /:countyFips so the literal segment wins.
 */
router.get("/counties", async (_req: Request, res: Response) => {
  try {
    const rows = (await db.select().from(servingSweepCounty)) as StoredRow[];
    const counties = rows
      .map((r) => ({
        countyFips: r.countyFips,
        countyName: r.countyName,
        sweptAt: r.sweptAt.toISOString(),
        ingestedAt: r.ingestedAt.toISOString(),
        resolverVersion: r.resolverVersion,
        parcelsTotal: r.parcelsTotal,
      }))
      .sort((a, b) => a.countyFips.localeCompare(b.countyFips));
    res.json({
      countiesSwept: counties.length,
      counties,
      servedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: "serving_sweep_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/serving-sweep/:countyFips — one CountyServingSweep, frozen shape.
 *
 * A county that was never swept answers 404 with a named reason. It is not an
 * empty sweep: "no sweep has been ingested for this county" and "this county
 * was swept and everything is absent" are opposite findings and must never
 * render the same.
 */
router.get("/:countyFips", async (req: Request, res: Response) => {
  const raw = req.params.countyFips;
  const countyFips = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (!COUNTY_FIPS_PATTERN.test(countyFips)) {
    res.status(400).json({
      error: "invalid_county_fips",
      message: "countyFips must be 5 digits, e.g. 48021",
      received: countyFips,
    });
    return;
  }
  try {
    const rows = (await db
      .select()
      .from(servingSweepCounty)
      .where(eq(servingSweepCounty.countyFips, countyFips))) as StoredRow[];
    const row = rows[0];
    if (!row) {
      res.status(404).json({
        error: "county_not_swept",
        message:
          "no serving sweep has been ingested for county " +
          countyFips +
          ". This is an absence of ingest, not a sweep that found nothing.",
        countyFips,
        servedAt: new Date().toISOString(),
      });
      return;
    }
    res.setHeader("X-Sweep-Assembled-At", new Date().toISOString());
    res.setHeader("X-Sweep-Swept-At", row.sweptAt.toISOString());
    res.setHeader("X-Sweep-Ingested-At", row.ingestedAt.toISOString());
    res.json(row.payload);
  } catch (err) {
    res.status(500).json({
      error: "serving_sweep_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/serving-sweep/ingest — the producer write path.
 *
 * Service token only, the same idiom as POST /api/onboarding-ledger/ingest:
 * the producer is hauska-engine's sweep runner, never a browser.
 *
 * Accepts EITHER one CountyServingSweep or a whole StatewideServingSweep, and
 * upserts one row per county. Validation is strict against the frozen record
 * and a rejection lists every problem BY PATH in one pass, so a producer
 * fixes its emitter once rather than discovering faults one request at a time.
 *
 * BODY SIZE IS A REAL BOUND. app.ts mounts `express.json()` with body-parser's
 * default 100kb limit, so a body above that answers 413 before this handler
 * runs. The two P-43 county artifacts measure 32,725 and 32,899 bytes, so a
 * per-county post has roughly 3x headroom; a 254-county statewide body does
 * NOT fit and must be posted county by county.
 */
router.post("/ingest", requireServiceToken, async (req: Request, res: Response) => {
  const parsed = parseServingSweepIngestBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({
      error: "invalid_serving_sweep",
      message:
        "body does not conform to the frozen serving-sweep record; nothing was stored",
      shapeRead: parsed.shape,
      problems: parsed.problems,
    });
    return;
  }

  try {
    const incomingFips = parsed.counties.map((c) => c.countyFips);
    const result = await db.transaction(async (tx) => {
      const existing = (await tx
        .select({ countyFips: servingSweepCounty.countyFips })
        .from(servingSweepCounty)
        .where(inArray(servingSweepCounty.countyFips, incomingFips))) as Array<{
        countyFips: string;
      }>;
      const existingFips = new Set(existing.map((r) => r.countyFips));
      for (const county of parsed.counties) {
        await tx
          .insert(servingSweepCounty)
          .values({
            countyFips: county.countyFips,
            countyName: county.countyName,
            sweptAt: new Date(county.sweptAt),
            resolverVersion: county.resolverVersion,
            parcelsTotal: county.parcelsTotal,
            payload: county,
          })
          .onConflictDoUpdate({
            target: servingSweepCounty.countyFips,
            set: {
              countyName: county.countyName,
              sweptAt: new Date(county.sweptAt),
              resolverVersion: county.resolverVersion,
              parcelsTotal: county.parcelsTotal,
              payload: county,
              ingestedAt: new Date(),
            },
          });
      }
      return {
        replaced: incomingFips.filter((f) => existingFips.has(f)),
        added: incomingFips.filter((f) => !existingFips.has(f)),
      };
    });

    res.status(200).json({
      ok: true,
      shapeRead: parsed.shape,
      countiesIngested: incomingFips.length,
      added: result.added,
      replaced: result.replaced,
      /** Counting rule stated where the number is read, not in a runbook. */
      countingRule:
        "countiesIngested counts county records in THIS body; added and replaced partition it by whether a row already existed for that FIPS",
      ingestedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: "serving_sweep_ingest_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as servingSweepRouter };
