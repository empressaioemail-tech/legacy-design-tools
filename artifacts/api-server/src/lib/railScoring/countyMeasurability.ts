/**
 * PER-COUNTY MEASURABILITY — the refusal that has to happen before a
 * denominator is computed, not after a zero is written.
 *
 * TWO DIFFERENT REFUSALS ALREADY EXISTED AND NEITHER COVERED THIS CASE.
 * `RailNotMeasurableError` in `./measure.ts` is RAIL-level: no measurement
 * spec, no atoms store. It abandons the whole rail across all 254 counties,
 * which is right for those causes and wrong for this one. Lane SS-W13's
 * `resolveStampFacetMeasurability` is COUNTY-level and is exactly right, but
 * it lives in `countyCoverageScoreCli.ts` and the rail-scoring capability
 * never called it.
 *
 * THE CONSEQUENCE, verified by reading `measureColumnStamp` on
 * `ss/w12-scorer-harness` at b6909582: the new capability, run over
 * `county_manifest`, would write `zoning` 0.00% `not-yet` for all 244 counties
 * with no wired city zoning layer. That is precisely the defect SS-W13 merged
 * a fix for one PR earlier — a 0% that measures this instrument's wiring and
 * reads as a claim about the county. Two lanes, one week, and the fix did not
 * travel because the capability was authored before the fix landed. So the
 * capability calls SS-W13's function rather than growing its own copy
 * (DEV_PROCESS 6.2: one authoritative copy; a duplicate is a future
 * contradiction). The engine already imports `classifyFacet` from that same
 * file for the same reason.
 *
 * A REFUSED CELL WRITES NO ROW. That is SS-W13's ruling, inherited whole: a
 * refusal leaves the ledger silent instead of asserting an absence nobody
 * established. What lane SS-W15 adds is that the silence is no longer
 * indistinguishable from a coverage gap on the console — see
 * `lib/db/src/manifestDisplayState.ts`.
 */

// The classifier moved out of countyCoverageScoreCli.ts on 2026-08-19 (lane
// SS-W18, P-47) -- that CLI's own module doc forbids re-exporting it (would
// put the file back on the import path that broke a canary deploy). Import
// from its current home directly; this branch predated that extraction.
import { resolveStampFacetMeasurability } from "../countyCoverageClassification";

/**
 * Refusal codes. The first three are SS-W13's, re-exported by value rather
 * than restated, so a change there is a type error here instead of a silent
 * divergence. The fourth is this lane's: the corrected denominator needs a
 * boundary table, and not having one is its own distinct state.
 */
export type CountyMeasurabilityRefusal =
  | "no-zoning-column"
  | "no-wired-layer"
  | "stamp-not-rolled"
  | "no-city-boundary-table"
  | "no-parcel-geometry"
  | "no-parcels";

export interface CountyMeasurability {
  measurable: boolean;
  refusal: CountyMeasurabilityRefusal | null;
  basis: string | null;
}

const MEASURABLE: CountyMeasurability = {
  measurable: true,
  refusal: null,
  basis: null,
};

export interface StampCellMeasurabilityInput {
  /** The parcel table the county actually resolved to, or null when neither holds it. */
  table: string | null;
  /** Whether THAT table carries the stamp column at all. */
  hasStampColumn: boolean;
  /** Count of wired city zoning layers for this county (`wiredZoningCityKeys(fips).size`). */
  wiredZoningLayers: number;
  /** Whether any parcel in the county carries a stamp. Drives `stamp-not-rolled`. */
  anyStamped: boolean;
  /** Whether the boundary table exists AND holds rows. Only checked for boundary denominators. */
  cityBoundaryRows: number;
  /** True when the declared denominator needs the municipal boundary table. */
  needsCityBoundary: boolean;
  /**
   * How many features carry a non-null PostGIS `geom`. Only its ZERO-ness is
   * consulted, so a caller may pass an `EXISTS` probe's 0-or-1 rather than a
   * full count: a parcel with no geometry cannot be located against a
   * boundary, so a county with none of them has no spatial denominator at all.
   * Only meaningful for a spatial denominator.
   */
  featuresWithGeom: number;
}

/**
 * Decide whether one county's stamp cell may be measured at all.
 *
 * PURE, so the rule is unit-testable with no database and every refusal branch
 * is provably able to FIRE (DEV_PROCESS 2.2). `countyMeasurability.test.ts`
 * exercises all five.
 *
 * ORDER IS PART OF THE RULE, AND IT WAS WRONG ONCE. Every refusal below can be
 * simultaneously true for the same county, so the one that gets reported is
 * the one somebody acts on. The rule is: report the constraint that BINDS.
 *
 *   1. `no-parcels`      nothing was acquired. Everything else is downstream.
 *   2. SS-W13's three    the INSTRUMENT's reach: no stamp column, no wired
 *                        city layer, stamp never rolled. `no-wired-layer` is
 *                        the binding constraint for 244 of 254 counties and
 *                        must dominate.
 *   3. boundary table    the denominator's own source is missing.
 *   4. `no-parcel-geometry`  the county is wired and stamped, and its parcels
 *                        still cannot be located.
 *
 * MEASURED, which is why this order and not the first one written: 189 of the
 * 253 counties holding parcels have a PostGIS `geom` on ZERO of them. With the
 * geometry check ahead of the reach checks, 189 counties reported
 * `no-parcel-geometry` — a true sentence naming work that would not make any
 * of them measurable, because they have no wired zoning layer either. It also
 * buried the one county where geometry IS the binding constraint. Caught by
 * running the CLI against Anderson 48001 and reading what it said, not by
 * reading the code.
 */
export function resolveStampCellMeasurability(
  input: StampCellMeasurabilityInput,
): CountyMeasurability {
  if (input.table === null) {
    return {
      measurable: false,
      refusal: "no-parcels",
      basis:
        "neither txgio_parcel nor txgio_parcel_staging holds any parcel for this county, " +
        "so there is no denominator to measure against. A zero here would be a claim " +
        "about the county produced by an empty acquisition.",
    };
  }
  // SS-W13's three refusals, called rather than copied.
  const stamp = resolveStampFacetMeasurability({
    table: input.table,
    hasZoningColumn: input.hasStampColumn,
    wiredZoningLayers: input.wiredZoningLayers,
    stampedPct: input.anyStamped ? 1 : 0,
  });
  if (!stamp.measurable) {
    return {
      measurable: false,
      refusal: stamp.refusal as CountyMeasurabilityRefusal,
      basis: stamp.basis,
    };
  }
  if (input.needsCityBoundary && input.cityBoundaryRows <= 0) {
    return {
      measurable: false,
      refusal: "no-city-boundary-table",
      basis:
        "the declared denominator counts parcels inside incorporated municipal boundaries, " +
        "and tx_city_boundary is absent or empty in this database. Falling back to the " +
        "county-wide parcel count would silently answer a different question — the exact " +
        "substitution that made Bastrop read 15.22% when it measures 79.60%.",
    };
  }
  if (input.needsCityBoundary && input.featuresWithGeom <= 0) {
    return {
      measurable: false,
      refusal: "no-parcel-geometry",
      basis:
        "this county is wired and stamped, but no parcel carries a PostGIS geom, so no " +
        "parcel can be located inside or outside a municipal boundary and the spatial " +
        "denominator does not " +
        "exist. FOUND LIVE: Caldwell 48055 holds 26,155 parcel features with geom on " +
        "zero of them, while every other wired county is at 100.00%; its jsonb geometry " +
        "and its bbox columns are both populated, so only the PostGIS column was never " +
        "backfilled. The fix is that backfill, not a fallback to the county-wide count.",
    };
  }
  return MEASURABLE;
}
