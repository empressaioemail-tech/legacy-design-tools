/**
 * Layer-0 coverage-honesty unit tests.
 *
 * Direct tests for the two pure functions the DEM coverage-honesty fix
 * introduced / reshaped in `siteTopographyIngest.ts`:
 *
 *   - `deriveContoursGeoJson`: the nodata-boundary honesty behavior. A
 *     fully-covered DEM emits every threshold with no drops and no
 *     boundary flags; a DEM with a nodata hole drops the spurious lowest
 *     isoline, sets `touchesNodata`, and flags floor-adjacent contours;
 *     and a fully-covered DEM whose real terrain sits at the global
 *     minimum keeps its legitimate lowest contour (the drop is gated on
 *     the PRESENCE of nodata, not on an elevation-equals-minimum
 *     coincidence).
 *
 *   - `computeTopoAssertedConfidence`: the confidence POLARITY (higher
 *     coverage -> higher estimate, monotonic), the asserted-baseline
 *     invariants (`provenance: "asserted"`, `n: 0`, `intervalWidth: 1`),
 *     the 0.85 cap that the unconditional resolution-unmeasured penalty
 *     imposes on a fully-covered fetch, and the [0, 1] clamp.
 *
 * These are the load-bearing tests: the polarity assertion is what stops
 * a future refactor from silently inverting the coverage-to-confidence
 * relationship.
 */

import { describe, it, expect } from "vitest";
import {
  deriveContoursGeoJson,
  computeTopoAssertedConfidence,
  type ParsedDem,
  type SiteTopographyCoverage,
} from "../siteTopographyIngest";
import type { BboxWgs84 } from "@workspace/site-context/server";

/** A unit-square WGS84 bbox; the pixel->lng/lat remap is not under test here. */
const TEST_BBOX: BboxWgs84 = {
  westLng: -98,
  southLat: 29,
  eastLng: -97,
  northLat: 30,
};

/**
 * Build a `ParsedDem` from a row-major 2D array of elevations, where
 * `null` marks a nodata cell (stored as NaN, exactly as `parseDemBytes`
 * encodes the 3DEP nodata sentinel). Computes `minElevation` /
 * `maxElevation` / `nodataCount` the same way the parser does so the
 * synthetic grid is indistinguishable from a parsed one.
 */
function makeDem(rows: ReadonlyArray<ReadonlyArray<number | null>>): ParsedDem {
  const height = rows.length;
  const width = rows[0]!.length;
  const values = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  let nodataCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = rows[y]![x]!;
      const idx = y * width + x;
      if (v === null) {
        values[idx] = Number.NaN;
        nodataCount++;
        continue;
      }
      values[idx] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    width,
    height,
    values,
    minElevation: min,
    maxElevation: max,
    nodataCount,
  };
}

/**
 * A fully-covered north-south elevation ramp: row y has elevation
 * `baseElev + y * step` across every column. Guarantees a monotone
 * gradient so d3-contour emits a distinct feature at every in-range
 * threshold. `size` rows by `size` cols.
 */
function makeRampDem(size: number, baseElev: number, step: number): ParsedDem {
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const rowElev = baseElev + y * step;
    rows.push(new Array<number>(size).fill(rowElev));
  }
  return makeDem(rows);
}

describe("deriveContoursGeoJson nodata-boundary honesty", () => {
  it("fully-covered DEM emits every threshold, drops nothing, no boundary flags", () => {
    // 10x10 ramp from 100m to 190m at 10m/row -> thresholds at 5m
    // interval land at 100,105,...,190. No nodata anywhere.
    const dem = makeRampDem(10, 100, 10);
    const result = deriveContoursGeoJson(dem, TEST_BBOX, 5);

    expect(dem.nodataCount).toBe(0);
    expect(result.touchesNodata).toBe(false);

    // Every emitted feature corresponds to one of the computed thresholds
    // and NONE were suppressed: the set of feature elevations equals the
    // set of thresholds d3-contour actually produced a ring for. On a
    // fully-covered DEM the filter is a no-op, so no threshold that
    // produced a ring is missing from the features.
    const featureElevations = new Set(
      result.featureCollection.features.map((f) => f.properties.elevationMeters),
    );
    // The lowest threshold must still be present (nothing dropped).
    const lowestThreshold = result.thresholds[0]!;
    expect(featureElevations.has(lowestThreshold)).toBe(true);

    // No feature carries the low-confidence boundary flag on a covered DEM.
    const flagged = result.featureCollection.features.filter(
      (f) => f.properties.onNodataBoundary === true,
    );
    expect(flagged).toHaveLength(0);
  });

  it("DEM with a nodata hole drops the spurious lowest isoline, flags the boundary, sets touchesNodata", () => {
    // Same ramp, but punch a nodata hole into the interior. With the
    // NaN->minElevation substitution the marching-squares run would draw a
    // spurious lowest-level isoline tracing the hole; the honesty fix
    // drops that level and flags the floor-adjacent survivors.
    const dem = makeRampDem(10, 100, 10);
    // Blank out a 3x3 interior block as nodata.
    for (let y = 4; y <= 6; y++) {
      for (let x = 4; x <= 6; x++) {
        dem.values[y * dem.width + x] = Number.NaN;
      }
    }
    // Recompute nodataCount to match the mutated grid (parser invariant).
    dem.nodataCount = 9;

    const covered = deriveContoursGeoJson(makeRampDem(10, 100, 10), TEST_BBOX, 5);
    const holed = deriveContoursGeoJson(dem, TEST_BBOX, 5);

    expect(holed.touchesNodata).toBe(true);

    // The spurious lowest isoline (the floor threshold) is dropped: the
    // holed collection must NOT carry a feature at the floor threshold,
    // whereas the fully-covered baseline (same thresholds) does.
    const floorThreshold = holed.thresholds[0]!;
    const holedElevations = holed.featureCollection.features.map(
      (f) => f.properties.elevationMeters,
    );
    const coveredElevations = covered.featureCollection.features.map(
      (f) => f.properties.elevationMeters,
    );
    expect(coveredElevations).toContain(floorThreshold);
    expect(holedElevations).not.toContain(floorThreshold);

    // At least one surviving floor-adjacent contour is flagged
    // low-confidence (onNodataBoundary), and every flag sits within one
    // interval of the floor.
    const flagged = holed.featureCollection.features.filter(
      (f) => f.properties.onNodataBoundary === true,
    );
    expect(flagged.length).toBeGreaterThan(0);
    for (const f of flagged) {
      expect(f.properties.elevationMeters).toBeLessThanOrEqual(
        floorThreshold + 5,
      );
    }
  });

  it("fully-covered DEM whose terrain sits at the global minimum keeps its lowest contour", () => {
    // This is the gating proof. A covered DEM with a legitimate low
    // plateau at the global minimum must NOT have its lowest contour
    // dropped: the drop is gated on `hasNodata`, not on
    // elevation-equals-minimum. Build a ramp identical in value-range to
    // the nodata-hole case above, but with ZERO nodata cells: the lowest
    // real terrain is a genuine 100m plateau across the whole bottom row.
    const dem = makeRampDem(10, 100, 10);
    expect(dem.nodataCount).toBe(0);
    expect(dem.minElevation).toBe(100);

    const result = deriveContoursGeoJson(dem, TEST_BBOX, 5);
    const floorThreshold = result.thresholds[0]!;

    // touchesNodata false, and the legitimate lowest contour survives.
    expect(result.touchesNodata).toBe(false);
    const elevations = result.featureCollection.features.map(
      (f) => f.properties.elevationMeters,
    );
    expect(elevations).toContain(floorThreshold);

    // And nothing is flagged low-confidence, because there is no boundary.
    const flagged = result.featureCollection.features.filter(
      (f) => f.properties.onNodataBoundary === true,
    );
    expect(flagged).toHaveLength(0);
  });
});

describe("computeTopoAssertedConfidence polarity and asserted invariants", () => {
  /** Coverage stub with a given coverage fraction; resolution unmeasured. */
  function coverageWith(
    coverageFraction: number,
    overrides: Partial<SiteTopographyCoverage> = {},
  ): SiteTopographyCoverage {
    return {
      nodataCount: Math.round((1 - coverageFraction) * 100),
      totalCells: 100,
      coverageFraction,
      resolutionMetersRequested: 10,
      resolutionMetersActual: null,
      resolutionMeasured: false,
      touchesNodata: coverageFraction < 1,
      ...overrides,
    };
  }

  it("POLARITY: higher coverage yields a higher estimate (monotonic)", () => {
    const low = computeTopoAssertedConfidence(coverageWith(0.1));
    const mid = computeTopoAssertedConfidence(coverageWith(0.5));
    const high = computeTopoAssertedConfidence(coverageWith(0.9));
    // This is the load-bearing assertion: coverage -> confidence must not
    // invert. High coverage MUST read more confident than low coverage.
    expect(low.estimate).toBeLessThan(mid.estimate);
    expect(mid.estimate).toBeLessThan(high.estimate);
  });

  it("a fully-covered fetch tops out at 0.85 given the unconditional -0.15 resolution penalty", () => {
    const full = computeTopoAssertedConfidence(coverageWith(1));
    // 0.25 floor + 0.75 * 1.0 coverage - 0.15 unmeasured penalty = 0.85.
    expect(full.estimate).toBeCloseTo(0.85, 10);
  });

  it("carries the asserted-baseline invariants: provenance asserted, n 0, full interval width", () => {
    const c = computeTopoAssertedConfidence(coverageWith(0.75));
    expect(c.provenance).toBe("asserted");
    expect(c.n).toBe(0);
    expect(c.intervalWidth).toBe(1);
  });

  it("a measured-resolution fetch scores higher than an unmeasured one at equal coverage", () => {
    const unmeasured = computeTopoAssertedConfidence(coverageWith(1));
    const measured = computeTopoAssertedConfidence(
      coverageWith(1, { resolutionMetersActual: 1, resolutionMeasured: true }),
    );
    // Removing the -0.15 penalty lifts a fully-covered measured fetch to
    // the full 1.0; it must beat the unmeasured 0.85.
    expect(measured.estimate).toBeGreaterThan(unmeasured.estimate);
    expect(measured.estimate).toBeCloseTo(1.0, 10);
  });

  it("clamps the estimate into [0, 1] for degenerate coverage fractions", () => {
    // Out-of-range / non-finite coverage fractions (a caller bug) must not
    // produce an out-of-range estimate; the contract constructor would
    // reject anything outside [0, 1] anyway, so the clamp is load-bearing.
    const negative = computeTopoAssertedConfidence(coverageWith(-5));
    const over = computeTopoAssertedConfidence(coverageWith(5));
    expect(negative.estimate).toBeGreaterThanOrEqual(0);
    expect(negative.estimate).toBeLessThanOrEqual(1);
    expect(over.estimate).toBeGreaterThanOrEqual(0);
    expect(over.estimate).toBeLessThanOrEqual(1);
  });
});
