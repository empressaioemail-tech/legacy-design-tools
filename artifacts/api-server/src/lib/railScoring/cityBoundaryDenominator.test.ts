/**
 * THE INCORPORATED-CITY DENOMINATOR — the counting rule, pinned.
 *
 * The SQL itself is exercised against the live store in the lane's dry-run
 * evidence; what is pinned here is everything a future edit could quietly
 * change without any query failing: that the numerator is a FILTER on the
 * denominator rather than a second count, that the denominator is never
 * derived from a column the stamp writes, and that the provenance carries the
 * escape count so a reader can tell the filter ran.
 */

import { describe, it, expect } from "vitest";
import {
  incorporatedDenominatorBasis,
  incorporatedStampDetail,
  measureIncorporatedStampCounts,
  readCityBoundaryAvailability,
  readLocatableFeatureCounts,
  CITY_BOUNDARY_TABLE,
  type IncorporatedStampCounts,
} from "./cityBoundaryDenominator";
import { formatRailScoreProvenance } from "./provenance";

/** Bastrop 48021 as measured 2026-08-19, read-only against the deployment store. */
const BASTROP: IncorporatedStampCounts = {
  incorporated: 11968,
  stamped: 9526,
  countyFeatures: 63357,
  countyFeaturesWithGeom: 63357,
  countyStamped: 9642,
  stampedOutsideBoundary: 116,
};

function fakeQ(rows: Record<string, unknown>[]) {
  const seen: string[] = [];
  return {
    seen,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: string): Promise<any> => {
      seen.push(text);
      return { rows };
    },
  };
}

describe("incorporated-city denominator: the counting rule", () => {
  it("states the rule in prose, including what it EXCLUDES and why", () => {
    const basis = incorporatedDenominatorBasis("zoning_district");
    expect(basis).toContain(CITY_BOUNDARY_TABLE);
    expect(basis).toContain("ST_PointOnSurface");
    expect(basis).toContain("unincorporated, no municipal zoning authority");
    // An instrument's exclusion set is part of its contract and must be stated
    // where its output is read (DEV_PROCESS 2.1).
    expect(basis).toContain("never inside it");
  });

  it("NAMES the tautology it refuses, so the shortcut cannot be reintroduced as a cleanup", () => {
    // Measured on Bastrop: zoning_district non-null = 9,642 and
    // zoning_jurisdiction non-null = 9,642, exactly, because one stamp writes
    // both. That ratio is 100.00% for every wired county and says nothing.
    const basis = incorporatedDenominatorBasis("zoning_district");
    expect(basis).toContain("zoning_jurisdiction");
    expect(basis).toContain("tautology");
    expect(basis).toContain("100.00%");
  });

  it("keeps the numerator inside the denominator: Bastrop is 79.60%, not 80.56%", () => {
    // The two-independent-counts version would be 9,642 / 11,968 = 80.56%.
    // The filtered version is 9,526 / 11,968 = 79.60%. Small here; on Travis
    // the same escape is 16,308 parcels. It is the `mud 209/186` shape.
    expect(BASTROP.stamped).toBeLessThanOrEqual(BASTROP.incorporated);
    const filtered = (BASTROP.stamped / BASTROP.incorporated) * 100;
    const unfiltered = (BASTROP.countyStamped / BASTROP.incorporated) * 100;
    expect(filtered.toFixed(2)).toBe("79.60");
    expect(unfiltered.toFixed(2)).toBe("80.56");
    expect(filtered).toBeLessThan(unfiltered);
  });

  it("reconciles the escape count rather than rounding it off", () => {
    // DEV_PROCESS 1.4: two numbers that should agree and do not is a free
    // finding. countyStamped and stamped SHOULD agree and do not, by 116.
    expect(BASTROP.stampedOutsideBoundary).toBe(
      BASTROP.countyStamped - BASTROP.stamped,
    );
    expect(BASTROP.stampedOutsideBoundary).toBe(116);
  });

  it("carries county totals, geom coverage and the escape count into provenance", () => {
    const detail = incorporatedStampDetail(BASTROP, "txgio_parcel", "zoning_district");
    expect(detail).toContain("countyFeatures=63357");
    expect(detail).toContain("geomFeatures=63357");
    expect(detail).toContain("countyStamped=9642");
    expect(detail).toContain("outside=116");
    // A reader seeing only 9526/11968 cannot tell whether the numerator was
    // filtered onto the denominator; `outside=` says the filter ran.
  });

  it("produces a provenance string the shared formatter accepts", () => {
    // `formatRailScoreProvenance` THROWS on a ';' in detail rather than
    // escaping it, so the detail's separators must be commas. This is the
    // round-trip that proves it.
    const detail = incorporatedStampDetail(BASTROP, "txgio_parcel", "zoning_district");
    const s = formatRailScoreProvenance({
      rail: "zoning",
      kind: "parcel-column-stamp-rate",
      numerator: BASTROP.stamped,
      denominator: BASTROP.incorporated,
      denominatorKind: "incorporated-city-parcels",
      detail,
    });
    expect(s).toContain("num=9526");
    expect(s).toContain("den=11968");
    expect(s).toContain("denKind=incorporated-city-parcels");
  });

  it("treats a MISSING boundary table and an EMPTY one as different facts", () => {
    // Both produce a zero denominator and mean completely different things.
    return (async () => {
      const missing = fakeQ([{ r: null }]);
      expect(await readCityBoundaryAvailability(missing)).toEqual({
        present: false,
        rows: 0,
      });
    })();
  });

  it("counts locatable features separately from features — measured, never subtracted", async () => {
    // DEV_PROCESS 1.3: measure the class you report. Caldwell 48055 is
    // 26,155 features and 0 with geom.
    const q = fakeQ([{ features: "26155", with_geom: "0" }]);
    const r = await readLocatableFeatureCounts(q, "txgio_parcel", "48055");
    expect(r).toEqual({ features: 26155, featuresWithGeom: 0 });
  });

  it("binds the county and never interpolates it into SQL", async () => {
    const q = fakeQ([
      { incorporated: "11968", stamped: "9526", county_features: "63357", county_stamped: "9642" },
    ]);
    const counts = await measureIncorporatedStampCounts(
      q,
      "txgio_parcel",
      "zoning_district",
      "48021",
      { features: 63357, featuresWithGeom: 63357 },
    );
    expect(counts).toEqual(BASTROP);
    const sql = q.seen[0] ?? "";
    expect(sql).toContain("$1");
    expect(sql).not.toContain("48021");
    // ST_Subdivide is load-bearing, not decoration: without it the Travis
    // query did not return inside a 2-minute budget.
    expect(sql).toContain("ST_Subdivide");
    // DISTINCT on the join, or a parcel matching several subdivided pieces
    // inflates the denominator in the safe-looking direction.
    expect(sql).toContain("SELECT DISTINCT p.feature_index");
    // The denominator comes from the boundary table and NEVER from a column
    // the stamp writes.
    expect(sql).toContain(CITY_BOUNDARY_TABLE);
    expect(sql).not.toContain("zoning_jurisdiction");
  });
});
