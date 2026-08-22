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
  geometryNumeratorQualifies,
  countGeometryNumerator,
  assertGeometryNumeratorExcludesRetired,
  GEOMETRY_ATOM_COUNT_SQL_ONE_COUNTY,
  ECTOR_GEOMETRY_FIPS,
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

describe("P-56 48135 numerator excludes retired prop_id", () => {
  const active = {
    entity_id: "48135:00050-00401-00100",
    status: "active",
    keyKind: "geo_id_crosswalk",
  };
  const retired = {
    entity_id: "48135:1004.00000000",
    status: "retired",
    keyKind: "prop_id",
  };

  it("SQL for one-county count excludes retired and requires geo_id on 48135", () => {
    expect(GEOMETRY_ATOM_COUNT_SQL_ONE_COUNTY).toContain(
      "COALESCE(body->>'status', 'active') = 'active'",
    );
    expect(GEOMETRY_ATOM_COUNT_SQL_ONE_COUNTY).toContain("$1 <> '48135'");
    expect(GEOMETRY_ATOM_COUNT_SQL_ONE_COUNTY).toContain(
      "IN ('geo_id', 'geo_id_crosswalk')",
    );
  });

  it("retired prop_id does not qualify on 48135; active geo_id does", () => {
    expect(geometryNumeratorQualifies(retired, ECTOR_GEOMETRY_FIPS)).toBe(false);
    expect(geometryNumeratorQualifies(active, ECTOR_GEOMETRY_FIPS)).toBe(true);
    expect(
      geometryNumeratorQualifies(
        { entity_id: "48135:x", status: "active", keyKind: "prop_id" },
        ECTOR_GEOMETRY_FIPS,
      ),
    ).toBe(false);
  });

  it("assert throws when the counted set includes retired ids", () => {
    expect(() =>
      assertGeometryNumeratorExcludesRetired([active, retired]),
    ).toThrow(/retired/);
    expect(() => assertGeometryNumeratorExcludesRetired([active])).not.toThrow();
  });

  it("fixture with retired ids cannot score satisfied-present by clamp (fill-to-100)", () => {
    const fixture = [
      ...Array.from({ length: 90 }, (_, i) => ({
        entity_id: `48135:active-${i}`,
        status: "active",
        keyKind: "geo_id_crosswalk",
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        entity_id: `48135:${i}.00000000`,
        status: "retired",
        keyKind: "prop_id",
      })),
    ];
    expect(() => assertGeometryNumeratorExcludesRetired(fixture)).toThrow(
      /retired/,
    );
    const naive = fixture.length;
    const honest = countGeometryNumerator(fixture, ECTOR_GEOMETRY_FIPS);
    expect(naive).toBe(100);
    expect(honest).toBe(90);
    const oldPath = scoreGeometry({
      fips: ECTOR_GEOMETRY_FIPS,
      name: "Ector",
      atomCount: naive,
      featureCount: 100,
    });
    const newPath = scoreGeometry({
      fips: ECTOR_GEOMETRY_FIPS,
      name: "Ector",
      atomCount: honest,
      featureCount: 100,
    });
    expect(oldPath.facet.honestCoveragePct).toBe(100);
    expect(oldPath.railState).toBe("satisfied-present");
    expect(newPath.facet.honestCoveragePct).toBe(90);
    expect(newPath.railState).toBe("not-yet");
    expect(newPath.railState).not.toBe("satisfied-present");
  });

  it("stock 48135 overcount 79650/75891 is not-yet, never clamped satisfied-present", () => {
    const over = scoreGeometry({
      fips: ECTOR_GEOMETRY_FIPS,
      name: "Ector",
      atomCount: 79650,
      featureCount: 75891,
    });
    expect(over.facet.honestCoveragePct).toBeCloseTo(104.9531565, 5);
    expect(over.railState).toBe("not-yet");
    expect(over.facet.honestCoveragePct).toBeGreaterThan(100);

    const honest = scoreGeometry({
      fips: ECTOR_GEOMETRY_FIPS,
      name: "Ector",
      atomCount: 75859,
      featureCount: 75891,
    });
    expect(honest.facet.honestCoveragePct).toBeCloseTo((75859 / 75891) * 100, 5);
    expect(honest.facet.honestCoveragePct).toBeLessThan(100);
    expect(honest.railState).toBe("satisfied-present");
    expect(honest.artifactPath).toContain("numerator=active-geo_id");
  });

  it("other counties still count active prop_id rows", () => {
    const row = {
      entity_id: "48021:34137",
      status: "active",
      keyKind: "prop_id",
    };
    expect(geometryNumeratorQualifies(row, "48021")).toBe(true);
    expect(
      geometryNumeratorQualifies({ ...row, status: "retired" }, "48021"),
    ).toBe(false);
  });
});
