/**
 * County ledger endpoint — the performance public data layer (R-FND-6, OPS-6).
 *
 * Serves the county_facet_coverage ledger to the Command Center factory-floor
 * console: per jurisdiction, the done/coverage/recipe-version/cert-state/
 * staleness/rewarm-unsafe/cost state. This is the operator's view of what has
 * been through the factory, at what recipe version, certified or not, and which
 * stamped truths have rotted (the staleness retirement rung, OPS-4).
 *
 * Read-only. Grouped by county FIPS with per-facet detail so the console can
 * render a county row + expand to facets.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, countyFacetCoverage } from "@workspace/db";

const router: IRouter = Router();

interface FacetRow {
  facet: string;
  honestCoveragePct: number | null;
  integrityVerdict: string;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  recipeVersion: string | null;
  certState: string | null;
  stalenessFlag: boolean;
  rewarmUnsafe: boolean;
  costUsd: number | null;
  onboarded: boolean;
  lastRewarmAt: string | null;
  lastRefreshAt: string | null;
}

interface CountyLedgerRow {
  countyFips: string;
  onboarded: boolean;
  /** True when ANY facet's stamp has rotted (staleness selector demoted it). */
  hasStale: boolean;
  /** True when ANY facet has an unfrozen decision (blocks a safe rewarm). */
  rewarmUnsafe: boolean;
  /** The min recipe version across facets (drives rewarm-needed vs current). */
  recipeVersions: string[];
  certStates: string[];
  facets: FacetRow[];
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * GET / — the full county ledger, grouped by FIPS. The CC console renders this
 * as the county-ledger panel (sortable/filterable performance surface).
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await db.select().from(countyFacetCoverage);

    const byCounty = new Map<string, CountyLedgerRow>();
    for (const r of rows) {
      const fips = r.countyFips;
      let county = byCounty.get(fips);
      if (!county) {
        county = {
          countyFips: fips,
          onboarded: false,
          hasStale: false,
          rewarmUnsafe: false,
          recipeVersions: [],
          certStates: [],
          facets: [],
        };
        byCounty.set(fips, county);
      }
      const facet: FacetRow = {
        facet: r.facet,
        honestCoveragePct: num(r.honestCoveragePct),
        integrityVerdict: r.integrityVerdict,
        ownerMatchRate: num(r.ownerMatchRate),
        source: r.source ?? null,
        sourceVintage: r.sourceVintage ?? null,
        recipeVersion: r.recipeVersion ?? null,
        certState: r.certState ?? null,
        stalenessFlag: Boolean(r.stalenessFlag),
        rewarmUnsafe: Boolean(r.rewarmUnsafe),
        costUsd: num(r.costUsd),
        onboarded: Boolean(r.onboarded),
        lastRewarmAt: iso(r.lastRewarmAt),
        lastRefreshAt: iso(r.lastRefreshAt),
      };
      county.facets.push(facet);
      if (facet.onboarded) county.onboarded = true;
      if (facet.stalenessFlag) county.hasStale = true;
      if (facet.rewarmUnsafe) county.rewarmUnsafe = true;
      if (facet.recipeVersion && !county.recipeVersions.includes(facet.recipeVersion))
        county.recipeVersions.push(facet.recipeVersion);
      if (facet.certState && !county.certStates.includes(facet.certState))
        county.certStates.push(facet.certState);
    }

    const counties = Array.from(byCounty.values()).sort((a, b) =>
      a.countyFips.localeCompare(b.countyFips),
    );

    res.json({
      counties,
      summary: {
        onboardedCount: counties.filter((c) => c.onboarded).length,
        totalCounties: counties.length,
        staleCount: counties.filter((c) => c.hasStale).length,
        rewarmUnsafeCount: counties.filter((c) => c.rewarmUnsafe).length,
      },
    });
  } catch (err) {
    // Honest failure — never a fabricated ledger. The console shows the error.
    res.status(500).json({
      error: "county_ledger_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as countyLedgerRouter };
