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
 *
 * County Manifest Sprint 1 (feat/county-manifest-sprint1) additive
 * extension: `manifestCells`, the full 254-county x N-rail grid, per the
 * operator ruling at doc_repo
 * `_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md`
 * and the build spec at
 * `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` section 5. This is a
 * NEW top-level response field — the existing `counties[]` shape (built
 * from the bare `county_facet_coverage` scan below) is UNCHANGED, so the
 * pre-existing Command Center panel keeps working unmodified while a new
 * manifest-grid view is built against `manifestCells`.
 *
 * Rail count fix 2026-08-08 (fix/county-rail-refresh): the ruling named
 * thirteen rails, but `join` (join quality) was ruled OUT of the rail
 * dimension the same day in a follow-up session — it is a DERIVED METRIC
 * of fit between two acquired rails, not a rail with its own
 * provenance/absence. The grid is 254 x `COUNTY_RAIL_COUNT` (12, from
 * `lib/db/src/schema/countyRailDimension.ts`), not a route-local literal.
 * That file also documents the `county_rail` dimension REFRESH fix: the
 * table was seeded once at migration 0068 and never updated, so three
 * atomFamilyState values (geometry/footprint/easement) had drifted stale-
 * optimistic-false; `countyRailRefreshCli.ts` re-syncs live rows against
 * the checked-in declaration on demand.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  countyFacetCoverage,
  countyManifest,
  jurisdictionRegistryRowMirror,
  countyGateCertState,
  onboardingLedgerEvent,
  COUNTY_RAIL_COUNT,
  COVERAGE_CLASS_BY_RAIL_KEY,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const router: IRouter = Router();

/**
 * One cell of the 254 x 13 manifest grid. `displayState` resolves per the
 * ruled precedence (spec section 3): `atomFamilyState != 'present'` =>
 * `no-atom`, regardless of any stored row; else `hasWriter = false` =>
 * `no-writer`, regardless of any stored row; else the stored `rail_state`,
 * or `not-yet` if no `county_facet_coverage` row exists for the cell. This
 * ordering is load-bearing: a rail with no atom family or no writer must
 * NEVER render a stray/leftover stored value as if it were real —
 * no-atom/no-writer dominate.
 */
export interface ManifestCell {
  countyFips: string;
  railKey: string;
  displayState:
    | "no-atom"
    | "no-writer"
    | "not-yet"
    | "satisfied-present"
    | "satisfied-absent";
  isPartial: boolean;
  honestCoveragePct: number | null;
  thresholdPct: number | null;
  atomFamilyState: string;
  hasWriter: boolean;
  absenceBasis: string | null;
  source: string | null;
  sourceVintage: string | null;
  lastVerifiedAt: string | null;
  verifiedByInstrument: string | null;
  verificationMethod: string | null;
  artifactPath: string | null;
}

interface ManifestGridQueryRow extends Record<string, unknown> {
  county_fips: string;
  rail_key: string;
  rail_default_threshold: string | number | null;
  atom_family_state: string;
  has_writer: boolean;
  rail_state: string | null;
  honest_coverage_pct: string | number | null;
  cell_threshold: string | number | null;
  absence_basis: string | null;
  source: string | null;
  source_vintage: string | null;
  last_verified_at: Date | string | null;
  verified_by_instrument: string | null;
  verification_method: string | null;
  artifact_path: string | null;
  display_state: ManifestCell["displayState"];
  is_partial: boolean;
}

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
 * P1.1 depth-rail satisfaction predicate (OPS-14). Jurisdiction-depth rails
 * must not render satisfied-present when honestCoveragePct is NULL or below
 * threshold — the stored rail_state alone is not sufficient. Statewide-uniform
 * rails keep SQL-derived display (satisfied-present + isPartial when below
 * threshold). satisfied-absent is never overridden here.
 */
export function applyDepthRailDisplayGate(cell: ManifestCell): ManifestCell {
  if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] !== "jurisdiction-depth") {
    return cell;
  }
  if (cell.displayState !== "satisfied-present") {
    return cell;
  }
  const threshold = cell.thresholdPct;
  const coverage = cell.honestCoveragePct;
  if (coverage === null || threshold === null || coverage < threshold) {
    return { ...cell, displayState: "not-yet", isPartial: false };
  }
  return cell;
}

/**
 * The full 254 x 13 manifest grid, County Manifest Sprint 1. Replaces the
 * bare `db.select().from(countyFacetCoverage)` read for this new field:
 * `county_manifest CROSS JOIN county_rail LEFT JOIN county_facet_coverage`,
 * so every one of 254 x 13 = 3,302 cells returns exactly one row, always —
 * a county with zero coverage rows still returns all 13 cells (derived
 * no-atom/no-writer/not-yet), and a rail with no atom family renders
 * `no-atom` for every county regardless of any stray stored row.
 *
 * Raw SQL (not the query builder): the precedence CASE is the load-bearing
 * part of this query and is clearer written once, explicitly, than
 * composed from partial Drizzle helpers. See spec section 3/5 for the
 * exact precedence rule and doc_repo
 * `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md`.
 */
async function readManifestGrid(): Promise<ManifestCell[]> {
  const { rows } = await db.execute<ManifestGridQueryRow>(sql`
    SELECT
      m.county_fips,
      r.rail_key,
      r.threshold_pct AS rail_default_threshold,
      r.atom_family_state,
      r.has_writer,
      c.rail_state,
      c.honest_coverage_pct,
      c.threshold_pct AS cell_threshold,
      c.absence_basis,
      c.source,
      c.source_vintage,
      c.last_verified_at,
      c.verified_by_instrument,
      c.verification_method,
      c.artifact_path,
      CASE
        WHEN r.atom_family_state <> 'present' THEN 'no-atom'
        WHEN r.has_writer = false THEN 'no-writer'
        WHEN c.rail_state IS NULL THEN 'not-yet'
        ELSE c.rail_state
      END AS display_state,
      CASE
        WHEN r.atom_family_state = 'present'
         AND r.has_writer = true
         AND c.rail_state = 'satisfied-present'
         AND c.honest_coverage_pct < COALESCE(c.threshold_pct, r.threshold_pct)
        THEN true
        ELSE false
      END AS is_partial
    FROM county_manifest m
    CROSS JOIN county_rail r
    LEFT JOIN county_facet_coverage c
      ON c.county_fips = m.county_fips
     AND c.facet = r.rail_key
    ORDER BY m.county_fips, r.ordinal
  `);
  return rows.map((row) =>
    applyDepthRailDisplayGate({
      countyFips: row.county_fips,
      railKey: row.rail_key,
      displayState: row.display_state,
      isPartial: Boolean(row.is_partial),
      honestCoveragePct: num(row.honest_coverage_pct),
      thresholdPct: num(row.cell_threshold ?? row.rail_default_threshold),
      atomFamilyState: row.atom_family_state,
      hasWriter: Boolean(row.has_writer),
      absenceBasis: row.absence_basis ?? null,
      source: row.source ?? null,
      sourceVintage: row.source_vintage ?? null,
      lastVerifiedAt: iso(row.last_verified_at),
      verifiedByInstrument: row.verified_by_instrument ?? null,
      verificationMethod: row.verification_method ?? null,
      artifactPath: row.artifact_path ?? null,
    }),
  );
}

/**
 * Doctrine-sourced cells are never SATISFIED for the rollup, defense-in-
 * depth (fix/manifest-doctrine-honesty, 2026-08-08). `zoning-regime-
 * doctrine` is one repeated string in the roster
 * ("PASS — county unincorporated = honest absence") applied identically
 * to all 254 counties; it is a true, scope-qualified finding about
 * unincorporated territory only, never a per-county measurement, and it
 * must never be able to count as a resolved rail for a county's
 * incorporated cities — regardless of what `rail_state` a future seed or
 * backfill happens to write for it. The seed CLI (`countyManifestSeedCli
 * .ts`) now writes these rows as `not-yet`, not `satisfied-absent`, so
 * this check is a belt-and-suspenders guard against the seed CLI's
 * discipline lapsing again, not the primary fix.
 */
const DOCTRINE_SOURCES_EXCLUDED_FROM_ROLLUP = new Set(["zoning-regime-doctrine"]);

/** A cell counts toward the Texas rollup only when SATISFIED (ruling 3): satisfied-present at/above threshold (not PARTIAL), or satisfied-absent. PARTIAL contributes zero. Doctrine-sourced cells never count — see DOCTRINE_SOURCES_EXCLUDED_FROM_ROLLUP. */
function isSatisfiedCell(cell: ManifestCell): boolean {
  if (cell.source && DOCTRINE_SOURCES_EXCLUDED_FROM_ROLLUP.has(cell.source)) {
    return false;
  }
  return (
    (cell.displayState === "satisfied-present" && !cell.isPartial) ||
    cell.displayState === "satisfied-absent"
  );
}

export interface RollupResult {
  texasPct: number;
  totalParcelWeight: number;
}

/**
 * Parcel-weighted Texas completeness rollup, per ruling 3 and spec
 * section 6: `100 * SUM(parcel_count_est * satisfied_count) /
 * (SUM(parcel_count_est) * 13)`. PARTIAL contributes zero. A county with
 * a NULL `parcelCountEst` (e.g. Donley, no-stratmap) contributes zero
 * weight to both numerator and denominator — it does not silently
 * inflate or deflate the statewide number, and it still appears in the
 * grid with its own cells for the per-county view.
 *
 * PURE — takes the manifest cells + a fips->parcelCountEst map, no I/O.
 * `railCount` defaults to `COUNTY_RAIL_COUNT` (the ruled rail count,
 * derived from `COUNTY_RAIL_DECLARATION` — 12 as of 2026-08-08, `join`
 * removed) but is a parameter so the small-fixture unit tests do not need
 * to fabricate every rail.
 */
export function computeTexasRollup(
  cells: ManifestCell[],
  parcelCountByFips: Map<string, number | null>,
  railCount = COUNTY_RAIL_COUNT,
): RollupResult {
  const satisfiedCountByFips = new Map<string, number>();
  for (const cell of cells) {
    if (!isSatisfiedCell(cell)) continue;
    satisfiedCountByFips.set(
      cell.countyFips,
      (satisfiedCountByFips.get(cell.countyFips) ?? 0) + 1,
    );
  }

  let numerator = 0;
  let denominator = 0;
  for (const [fips, parcelCountEst] of parcelCountByFips) {
    const weight = parcelCountEst ?? 0;
    const satisfiedCount = satisfiedCountByFips.get(fips) ?? 0;
    numerator += weight * satisfiedCount;
    denominator += weight;
  }

  const totalDenominator = denominator * railCount;
  return {
    texasPct: totalDenominator > 0 ? (100 * numerator) / totalDenominator : 0,
    totalParcelWeight: denominator,
  };
}

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
    //
    // County Manifest Sprint 1, additive: the full manifest grid (3,302
    // cells always) + the manifest rows (254, for identity/name/
    // parcel_count_est and the rollup denominator). Independent of the
    // facet-scorecard scan above; failure here must not break the
    // pre-existing `counties[]` response, so this is fetched alongside,
    // not instead of, the existing reads.
    const [mirrorRows, gateCertRows, openEvents, manifestCells, manifestRows, capabilityOutcome] =
      await Promise.all([
        db.select().from(jurisdictionRegistryRowMirror),
        db.select().from(countyGateCertState),
        db
          .select()
          .from(onboardingLedgerEvent)
          .where(eq(onboardingLedgerEvent.status, "open")),
        readManifestGrid(),
        db.select().from(countyManifest),
        probeRailCapabilities(db),
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

    // County Manifest Sprint 1. totalCounties is now the real denominator —
    // the manifest's row count (254 by construction once seeded), NOT
    // counties.length (the count of fips that happen to have a
    // county_facet_coverage or registry-mirror row, i.e. an accident of
    // what was worked; see doc_repo
    // `_inbox/2026-08-08_LEDGER_schema_audit.md` section 3). Falls back to
    // counties.length only if the manifest has not been seeded yet, so the
    // pre-seed response does not silently claim a bogus "0 of 254".
    const totalCounties = manifestRows.length || counties.length;
    const satisfiedCells = manifestCells.filter(isSatisfiedCell).length;
    const satisfiedPresentCells = manifestCells.filter(
      (c) => c.displayState === "satisfied-present",
    ).length;
    const satisfiedPresentPartialCells = manifestCells.filter(
      (c) => c.displayState === "satisfied-present" && c.isPartial,
    ).length;
    const satisfiedAbsentCells = manifestCells.filter(
      (c) => c.displayState === "satisfied-absent",
    ).length;
    const parcelCountByFips = new Map(
      manifestRows.map((m) => [m.countyFips, num(m.parcelCountEst)]),
    );
    const rollup = computeTexasRollup(manifestCells, parcelCountByFips);

    res.json({
      counties,
      // County Manifest Sprint 1, NEW field: the full 254 x 13 grid
      // (3,302 cells, always). Additive — does not replace `counties[]`.
      manifestCells,
      summary: {
        onboardedCount: counties.filter((c) => c.onboarded).length,
        totalCounties,
        staleCount: counties.filter((c) => c.hasStale).length,
        rewarmUnsafeCount: counties.filter((c) => c.rewarmUnsafe).length,
        // County Manifest Sprint 1, NEW summary fields. totalRails derives
        // from COUNTY_RAIL_DECLARATION (lib/db/src/schema/
        // countyRailDimension.ts), not a route-local literal — 12 as of
        // 2026-08-08 (`join` removed; see countyRailRefreshCli.ts header).
        totalRails: COUNTY_RAIL_COUNT,
        totalCells: manifestCells.length,
        // Rollup gate (ruling 3): non-partial satisfied-present + satisfied-absent.
        // PARTIAL cells (displayState satisfied-present, isPartial true) are
        // visible on manifestCells but excluded here — see isSatisfiedCell().
        satisfiedCells,
        satisfiedPresentCells,
        satisfiedPresentPartialCells,
        satisfiedAbsentCells,
        texasCompletenessPct: rollup.texasPct,
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
