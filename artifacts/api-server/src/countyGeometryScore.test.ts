/**
 * Geometry-rail scorer — pure-core unit tests (no DB).
 *
 * Covers `scoreGeometry`: given atom count + txgio_parcel DISTINCT
 * feature_index count, the scorer must classify honestly and gate
 * rail_state at the 95% threshold — a below-threshold county must render
 * `not-yet` with its REAL honest_coverage_pct, never `satisfied-present`
 * (the standing ruling that keeps PARTIAL counties contributing zero to
 * the Texas rollup).
 *
 * L7 honest absence: satisfied-absent only with a complete positive
 * determination; incomplete/missing evidence fail-closes to not-yet.
 *
 * Atom keying note: parcel-node counts key on left(entity_id, 5);
 * body.countyFips may be null (Harris 48201). See countyFipsFromAtomRow.
 */

import { describe, it, expect } from "vitest";
import {
  scoreGeometry,
  countyFipsFromAtomRow,
} from "./countyGeometryScoreCli";

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
    expect(r.absenceBasis).toBeNull();
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
    expect(r.absenceBasis).toBeNull();
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

  it("no txgio_parcel denominator (featureCount null) without determination -> true-source-gap, coverage 0, not-yet (fail closed)", () => {
    const r = scoreGeometry({
      fips: "48999",
      name: "NoSource",
      atomCount: 0,
      featureCount: null,
    });
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.facet.honestCoveragePct).toBe(0);
    expect(r.railState).toBe("not-yet");
    expect(r.absenceBasis).toBeNull();
  });

  it("zero features (source table present but empty for county) without determination -> true-source-gap, not satisfied", () => {
    const r = scoreGeometry({
      fips: "48998",
      name: "ZeroFeatures",
      atomCount: 0,
      featureCount: 0,
    });
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.railState).toBe("not-yet");
    expect(r.absenceBasis).toBeNull();
  });

  it("atom count exceeding feature count fail-closes: does not clamp to 100% satisfied-present (SF-25)", () => {
    const r = scoreGeometry({
      fips: "48997",
      name: "Overcount",
      atomCount: 600,
      featureCount: 538,
    });
    expect(r.facet.honestCoveragePct).toBeGreaterThan(100);
    expect(r.railState).toBe("not-yet");
    expect(r.absenceBasis).toBeNull();
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

  it("source is parcel-node-atom-count when features present, null when absent without determination", () => {
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

  it("complete absence determination + null features -> satisfied-absent with absenceBasis set", () => {
    const r = scoreGeometry({
      fips: "48129",
      name: "Donley",
      atomCount: 0,
      featureCount: null,
      absenceDetermination: {
        absenceBasis: "txgio-parcel-universe-absent-county-confirmed",
        verifiedByInstrument: "countyGeometryScoreCli.ts",
        artifactPath: "docs/outreach/donley-geometry-absence.md",
        source: "honest-absence-determination",
      },
    });
    expect(r.railState).toBe("satisfied-absent");
    expect(r.absenceBasis).toBe("txgio-parcel-universe-absent-county-confirmed");
    expect(r.verifiedByInstrument).toBe("countyGeometryScoreCli.ts");
    expect(r.artifactPath).toBe("docs/outreach/donley-geometry-absence.md");
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.facet.source).toBe("honest-absence-determination");
    expect(r.facet.honestCoveragePct).toBe(0);
  });

  it("complete absence determination + zero features -> satisfied-absent", () => {
    const r = scoreGeometry({
      fips: "48129",
      name: "Donley",
      atomCount: 0,
      featureCount: 0,
      absenceDetermination: {
        absenceBasis: "no-txgio-features-verified",
        verifiedByInstrument: "countyGeometryScoreCli.ts",
      },
    });
    expect(r.railState).toBe("satisfied-absent");
    expect(r.absenceBasis).toBe("no-txgio-features-verified");
    expect(r.facet.classification).toBe("true-source-gap");
    expect(r.facet.source).toBe("honest-absence-determination");
  });

  it("incomplete determination (missing verifiedByInstrument) fail-closes to not-yet", () => {
    const r = scoreGeometry({
      fips: "48129",
      name: "Donley",
      atomCount: 0,
      featureCount: null,
      absenceDetermination: {
        absenceBasis: "claimed-absent",
        verifiedByInstrument: "",
      },
    });
    expect(r.railState).toBe("not-yet");
    expect(r.absenceBasis).toBeNull();
  });

  it("incomplete determination (missing absenceBasis) fail-closes to not-yet", () => {
    const r = scoreGeometry({
      fips: "48129",
      name: "Donley",
      atomCount: 0,
      featureCount: null,
      absenceDetermination: {
        absenceBasis: "   ",
        verifiedByInstrument: "countyGeometryScoreCli.ts",
      },
    });
    expect(r.railState).toBe("not-yet");
    expect(r.absenceBasis).toBeNull();
  });

  it("features > 0 never yields satisfied-absent even if determination supplied", () => {
    const r = scoreGeometry({
      fips: "48261",
      name: "Kenedy",
      atomCount: 529,
      featureCount: 538,
      absenceDetermination: {
        absenceBasis: "should-be-ignored",
        verifiedByInstrument: "countyGeometryScoreCli.ts",
      },
    });
    expect(r.railState).toBe("satisfied-present");
    expect(r.absenceBasis).toBeNull();
  });
});

describe("countyFipsFromAtomRow", () => {
  it("prefers left(entity_id, 5) when body.countyFips is null (Harris pattern)", () => {
    expect(
      countyFipsFromAtomRow({
        entity_id: "48201:123456",
        body: { countyFips: null },
      }),
    ).toBe("48201");
  });

  it("falls back to body.countyFips when entity_id has no leading fips", () => {
    expect(
      countyFipsFromAtomRow({
        entity_id: "parcel-abc",
        body: { countyFips: "48021" },
      }),
    ).toBe("48021");
  });

  it("returns null when neither key is usable", () => {
    expect(
      countyFipsFromAtomRow({
        entity_id: "parcel-abc",
        body: {},
      }),
    ).toBeNull();
  });
});
