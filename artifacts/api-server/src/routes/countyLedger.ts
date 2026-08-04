/**
 * County ledger endpoint, the performance public data layer (R-FND-6, OPS-6).
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
import {
  db,
  countyFacetCoverage,
  jurisdictionRegistryRowMirror,
  countyGateCertState,
  onboardingLedgerEvent,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

interface FacetRow {
  facet: string;
  honestCoveragePct: number | null;
  integrityVerdict: string;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  recipeVersion: string | null;
  /** @deprecated OPS-9 S1, superseded by `rows[].cert` (county_gate_cert_state). Kept for backward compatibility; not migrated. */
  certState: string | null;
  stalenessFlag: boolean;
  rewarmUnsafe: boolean;
  costUsd: number | null;
  /** @deprecated OPS-9 S1, superseded by `rows[].gate` (county_gate_cert_state). Kept for backward compatibility; not migrated. */
  onboarded: boolean;
  lastRewarmAt: string | null;
  lastRefreshAt: string | null;
}

/** OPS-9 S1, one registry row's onboarding-ledger state (additive to the facet-scorecard view above). */
interface RegistryRowLedgerView {
  rowId: string;
  countyName: string | null;
  gate: {
    passCount: number | null;
    declineCount: number | null;
    checks: unknown;
  } | null;
  cert: {
    label: string | null;
    blockPass: boolean | null;
    scopeAnnotations: unknown;
    gradedAt: string | null;
  } | null;
  openDefectClasses: Array<{ defectClass: string; count: number }>;
  focusedFixCount: number;
}

interface CountyLedgerRow {
  countyFips: string;
  /** Set when a jurisdiction_registry_row_mirror row carries a countyName for this fips. */
  countyName: string | null;
  onboarded: boolean;
  /** True when ANY facet's stamp has rotted (staleness selector demoted it). */
  hasStale: boolean;
  /** True when ANY facet has an unfrozen decision (blocks a safe rewarm). */
  rewarmUnsafe: boolean;
  /** The min recipe version across facets (drives rewarm-needed vs current). */
  recipeVersions: string[];
  certStates: string[];
  facets: FacetRow[];
  /** OPS-9 S1, per-registry-row onboarding-ledger state for this fips. */
  rows: RegistryRowLedgerView[];
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * GET /, the full county ledger, grouped by FIPS. The CC console renders this
 * as the county-ledger panel (sortable/filterable performance surface).
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await db.select().from(countyFacetCoverage);
    // OPS-9 S1, additive join: registry-row mirror + gate/cert state +
    // open ledger events, keyed by fips / rowId. Read-only; never mutates
    // county_facet_coverage.
    const [mirrorRows, gateCertRows, openEvents] = await Promise.all([
      db.select().from(jurisdictionRegistryRowMirror),
      db.select().from(countyGateCertState),
      db
        .select()
        .from(onboardingLedgerEvent)
        .where(eq(onboardingLedgerEvent.status, "open")),
    ]);

    const gateCertByRowId = new Map(gateCertRows.map((g) => [g.rowId, g]));
    const openEventsByRowId = new Map<string, typeof openEvents>();
    for (const ev of openEvents) {
      const list = openEventsByRowId.get(ev.rowId) ?? [];
      list.push(ev);
      openEventsByRowId.set(ev.rowId, list);
    }

    const byCounty = new Map<string, CountyLedgerRow>();
    for (const r of rows) {
      const fips = r.countyFips;
      let county = byCounty.get(fips);
      if (!county) {
        county = {
          countyFips: fips,
          countyName: null,
          onboarded: false,
          hasStale: false,
          rewarmUnsafe: false,
          recipeVersions: [],
          certStates: [],
          facets: [],
          rows: [],
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

    // OPS-9 S1, attach the per-registry-row ledger view. A fips can have a
    // registry mirror row (pre-flight-pending or active) with NO
    // county_facet_coverage rows yet (not warmed/scored), so this creates
    // the county entry when it is not already present.
    for (const mirror of mirrorRows) {
      let county = byCounty.get(mirror.fips);
      if (!county) {
        county = {
          countyFips: mirror.fips,
          countyName: mirror.countyName,
          onboarded: false,
          hasStale: false,
          rewarmUnsafe: false,
          recipeVersions: [],
          certStates: [],
          facets: [],
          rows: [],
        };
        byCounty.set(mirror.fips, county);
      } else if (!county.countyName) {
        county.countyName = mirror.countyName;
      }

      const gc = gateCertByRowId.get(mirror.rowId);
      const openForRow = openEventsByRowId.get(mirror.rowId) ?? [];
      const defectCounts = new Map<string, number>();
      for (const ev of openForRow) {
        defectCounts.set(ev.defectClass, (defectCounts.get(ev.defectClass) ?? 0) + 1);
      }

      county.rows.push({
        rowId: mirror.rowId,
        countyName: mirror.countyName,
        gate: gc
          ? {
              passCount: gc.gatePassCount ?? null,
              declineCount: gc.gateDeclineCount ?? null,
              checks: gc.gateChecks ?? null,
            }
          : null,
        cert: gc
          ? {
              label: gc.certLabel ?? null,
              blockPass: gc.certBlockPass ?? null,
              scopeAnnotations: gc.certScopeAnnotations ?? null,
              gradedAt: iso(gc.certGradedAt),
            }
          : null,
        openDefectClasses: Array.from(defectCounts.entries()).map(([defectClass, count]) => ({
          defectClass,
          count,
        })),
        focusedFixCount: openForRow.length,
      });
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
    // Honest failure, never a fabricated ledger. The console shows the error.
    res.status(500).json({
      error: "county_ledger_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as countyLedgerRouter };
