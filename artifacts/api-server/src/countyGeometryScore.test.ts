/**
 * Geometry-rail scorer — pure-core unit tests (no DB).
 *
 * Covers `scoreGeometry`: given atom count + txgio_parcel DISTINCT
 * feature_index count, the scorer must classify honestly and gate
 * rail_state at the 95% threshold — a below-threshold county must render
 * `not-yet` with its REAL honest_coverage_pct, never `satisfied-present`
 * (the standing ruling that keeps PARTIAL counties contributing zero to
 * the Texas rollup).
 */

import { describe, it, expect } from "vitest";
import { scoreGeometry } from "./countyGeometryScoreCli";

describe("scoreGeometry", () => {
  it("Kenedy: 529 atoms / 538 features = ~98.3%, above 95% threshold -> satisfied-present", () => {
    const r = scoreGeometry({
      fips: "48261",
      name: "Kenedy",
      atomCount: 529,
      featureCount: 538,
    });
    expect(r.facet.classification).toBe("real-at-ceiling");
    expect(r.facet.honestCoveragePct).toBeCloseTo((529 / 538) * 100, 5);
    expect(r.facet.honestCoveragePct).toBeGreaterThanOrEqual(95);
    expect(r.railState).toBe("satisfied-present");
  });

  it("a county below 95% coverage writes not-yet with its REAL coverage, never satisfied-present", () => {
    const r = scoreGeometry({
      fips: "48001",
      name: "Anderson",
      atomCount: 400,
      featureCount: 1000, // 40%
    });
    expect(r.facet.honestCoveragePct).toBeCloseTo(40, 5);
    expect(r.railState).toBe("not-yet");
    // The real number is stored, not zeroed or hidden.
    expect(r.facet.classification).toBe("real-at-ceiling");
  });

  it("exactly at threshold (95.00%) -> satisfied-present (>= boundary, not >)", () => {
    const r = scoreGeometry({
      fips: "48000",
      name: "Test",
      atomCount: 950,
      featureCount: 1000,
    });
    expect(r.facet.honestCoveragePct).toBeCloseTo(95, 5);
    expect(r.railState).toBe("satisfied-present");
  });

  it("just under threshold (94.9%) -> not-yet", () => {
    const r = scoreGeometry({
      fips: "48000",
      name: "Test",
      atomCount: 949,
      featureCount: 1000,
    });
    expect(r.facet.honestCoveragePct).toBeCloseTo(94.9, 5);
    expect(r.railState).toBe("not-yet");
  });

  it("no txgio_parcel denominator (featureCount null) -> true-source-gap, coverage 0, not-yet", () => {
    const r = scoreGeometry({
      fips: "48999",
      name: "NoSource",
      atomCount: 0,
      featureCount: null,
    });
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.facet.honestCoveragePct).toBe(0);
    expect(r.railState).toBe("not-yet");
  });

  it("zero features (source table present but empty for county) -> true-source-gap, not satisfied", () => {
    const r = scoreGeometry({
      fips: "48998",
      name: "ZeroFeatures",
      atomCount: 0,
      featureCount: 0,
    });
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.railState).toBe("not-yet");
  });

  it("atom count exceeding feature count (stale/duplicate atoms) clamps coverage at 100%, still satisfied-present", () => {
    const r = scoreGeometry({
      fips: "48997",
      name: "Overcount",
      atomCount: 600,
      featureCount: 538,
    });
    expect(r.facet.honestCoveragePct).toBe(100);
    expect(r.railState).toBe("satisfied-present");
  });

  it("has no owner-match oracle: verdict is always n/a, ownerMatchRate always null", () => {
    const r = scoreGeometry({
      fips: "48261",
      name: "Kenedy",
      atomCount: 529,
      featureCount: 538,
    });
    expect(r.facet.integrityVerdict).toBe("n/a");
    expect(r.facet.ownerMatchRate).toBeNull();
  });

  it("source is parcel-node-atom-count when features present, null when absent", () => {
    const present = scoreGeometry({
      fips: "48261",
      name: "Kenedy",
      atomCount: 529,
      featureCount: 538,
    });
    expect(present.facet.source).toBe("parcel-node-atom-count");

    const absent = scoreGeometry({
      fips: "48999",
      name: "NoSource",
      atomCount: 0,
      featureCount: null,
    });
    expect(absent.facet.source).toBeNull();
  });
});
