/**
 * Pure unit tests for the County Manifest Sprint 1 Texas rollup formula
 * (`computeTexasRollup` in `../countyLedger.ts`). No database, no
 * `vi.mock`, no Express harness — these run in every environment
 * (including one with no Postgres reachable), unlike the integration
 * tests in `countyLedger.test.ts` which require TEST_DATABASE_URL /
 * DATABASE_URL.
 *
 * Formula under test, per the operator ruling at doc_repo
 * `_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md`
 * ruling 3 and the build spec at
 * `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` section 6:
 *
 *   texas_pct = 100 * SUM(parcel_count_est * satisfied_count)
 *             / (SUM(parcel_count_est) * railCount)
 *
 * where satisfied_count(county) counts cells that are
 * `satisfied-present` AND NOT partial, OR `satisfied-absent`. PARTIAL
 * contributes zero. `no-atom` / `no-writer` / `not-yet` all contribute
 * zero (only the two satisfied states count).
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
});

import { computeTexasRollup, applyDepthRailDisplayGate, type ManifestCell } from "../countyLedger";

function cell(
  countyFips: string,
  railKey: string,
  displayState: ManifestCell["displayState"],
  isPartial = false,
  source: string | null = null,
): ManifestCell {
  return {
    countyFips,
    railKey,
    displayState,
    isPartial,
    honestCoveragePct: null,
    thresholdPct: null,
    atomFamilyState: "present",
    hasWriter: true,
    absenceBasis: null,
    source,
    sourceVintage: null,
    lastVerifiedAt: null,
    verifiedByInstrument: null,
    verificationMethod: null,
    artifactPath: null,
  };
}

describe("computeTexasRollup", () => {
  it("returns 0 for an empty grid (no divide-by-zero)", () => {
    const result = computeTexasRollup([], new Map());
    expect(result.texasPct).toBe(0);
    expect(result.totalParcelWeight).toBe(0);
  });

  it("a county fully satisfied across all rails scores 100 alone", () => {
    const railCount = 3;
    const cells: ManifestCell[] = [
      cell("48021", "zoning", "satisfied-present"),
      cell("48021", "envelope", "satisfied-present"),
      cell("48021", "roads", "satisfied-absent"),
    ];
    const parcelCountByFips = new Map([["48021", 100]]);
    const result = computeTexasRollup(cells, parcelCountByFips, railCount);
    expect(result.texasPct).toBe(100);
  });

  it("a county with zero satisfied cells scores 0", () => {
    const railCount = 3;
    const cells: ManifestCell[] = [
      cell("48021", "zoning", "no-atom"),
      cell("48021", "envelope", "no-writer"),
      cell("48021", "roads", "not-yet"),
    ];
    const parcelCountByFips = new Map([["48021", 100]]);
    const result = computeTexasRollup(cells, parcelCountByFips, railCount);
    expect(result.texasPct).toBe(0);
  });

  it("PARTIAL contributes zero, even though the rail has an atom + writer", () => {
    const railCount = 1;
    const cells: ManifestCell[] = [
      cell("48021", "zoning", "satisfied-present", /* isPartial */ true),
    ];
    const parcelCountByFips = new Map([["48021", 100]]);
    const result = computeTexasRollup(cells, parcelCountByFips, railCount);
    expect(result.texasPct).toBe(0);
  });

  it("satisfied-absent counts fully, same as a non-partial satisfied-present", () => {
    const railCount = 1;
    const absentCells: ManifestCell[] = [
      cell("48021", "zoning", "satisfied-absent"),
    ];
    const presentCells: ManifestCell[] = [
      cell("48021", "zoning", "satisfied-present", false),
    ];
    const weights = new Map([["48021", 100]]);
    expect(computeTexasRollup(absentCells, weights, railCount).texasPct).toBe(
      computeTexasRollup(presentCells, weights, railCount).texasPct,
    );
  });

  it("a doctrine-sourced satisfied-absent cell (source='zoning-regime-doctrine') contributes zero, even though displayState reads satisfied-absent (fix/manifest-doctrine-honesty regression guard)", () => {
    const railCount = 1;
    // Same shape as the pre-fix live defect: 254 counties' zoning rail all
    // stamped satisfied-absent from one repeated roster doctrine string,
    // which is a true finding about UNINCORPORATED territory only and must
    // never resolve county-wide zoning completeness. This asserts the
    // isSatisfiedCell defense-in-depth guard in countyLedger.ts, not just
    // the seed CLI's discipline — a future seed/backfill that mistakenly
    // writes satisfied-absent again for this source must still contribute
    // zero to the rollup.
    const doctrineCells: ManifestCell[] = [
      cell("48201", "zoning", "satisfied-absent", false, "zoning-regime-doctrine"),
    ];
    const weights = new Map([["48201", 1_000_000]]);
    const result = computeTexasRollup(doctrineCells, weights, railCount);
    expect(result.texasPct).toBe(0);
  });

  it("a non-doctrine-sourced satisfied-absent cell still counts fully (the exclusion is source-specific, not blanket)", () => {
    const railCount = 1;
    const cells: ManifestCell[] = [
      cell("48021", "roads", "satisfied-absent", false, "some-other-source"),
    ];
    const weights = new Map([["48021", 100]]);
    const result = computeTexasRollup(cells, weights, railCount);
    expect(result.texasPct).toBe(100);
  });

  it("parcel-weights across counties (Harris-sized county dominates a Loving-sized one)", () => {
    const railCount = 2;
    // Big county: 0 of 2 rails satisfied. Small county: 2 of 2 satisfied.
    const cells: ManifestCell[] = [
      cell("48201", "zoning", "not-yet"), // Harris-like, huge parcel weight, unsatisfied
      cell("48201", "roads", "not-yet"),
      cell("48301", "zoning", "satisfied-present"), // Loving-like, tiny parcel weight, fully satisfied
      cell("48301", "roads", "satisfied-absent"),
    ];
    const parcelCountByFips = new Map([
      ["48201", 1_000_000],
      ["48301", 10],
    ]);
    const result = computeTexasRollup(cells, parcelCountByFips, railCount);
    // numerator = 1,000,000*0 + 10*2 = 20; denominator = (1,000,000+10)*2
    const expected = (100 * 20) / ((1_000_000 + 10) * 2);
    expect(result.texasPct).toBeCloseTo(expected, 10);
    // The big county's overwhelming weight should keep the statewide
    // number near zero even though one whole county is 100% complete —
    // this is the load-bearing point of parcel-weighting (ruling 3 /
    // spec section 6): a tiny fully-done county must not move the
    // headline number much.
    expect(result.texasPct).toBeLessThan(0.01);
  });

  it("a county with a NULL parcelCountEst contributes zero weight to both numerator and denominator (Donley case)", () => {
    const railCount = 2;
    const cells: ManifestCell[] = [
      cell("48129", "zoning", "satisfied-present"), // Donley-like, fully satisfied but unweighable
      cell("48129", "roads", "satisfied-absent"),
      cell("48021", "zoning", "not-yet"), // a normal weighable county, unsatisfied
      cell("48021", "roads", "not-yet"),
    ];
    const parcelCountByFips = new Map<string, number | null>([
      ["48129", null],
      ["48021", 500],
    ]);
    const result = computeTexasRollup(cells, parcelCountByFips, railCount);
    // Donley contributes 0 weight either way, so the result is driven
    // entirely by 48021 (0 satisfied) -> 0%, NOT skewed positive by
    // Donley's 100%-complete-but-unweighable cells.
    expect(result.texasPct).toBe(0);
    // Total parcel weight excludes the NULL county entirely.
    expect(result.totalParcelWeight).toBe(500);
  });
});

describe("applyDepthRailDisplayGate", () => {
  function baseCell(overrides: Partial<ManifestCell> = {}): ManifestCell {
    return {
      countyFips: "48021", railKey: "zoning", displayState: "satisfied-present",
      isPartial: true, honestCoveragePct: 33.98, thresholdPct: 95,
      atomFamilyState: "present", hasWriter: true, absenceBasis: null,
      source: null, sourceVintage: null, lastVerifiedAt: null,
      verifiedByInstrument: null, verificationMethod: null, artifactPath: null,
      ...overrides,
    };
  }

  it("downgrades jurisdiction-depth satisfied-present below threshold to not-yet", () => {
    const result = applyDepthRailDisplayGate(baseCell());
    expect(result.displayState).toBe("not-yet");
    expect(result.isPartial).toBe(true);
  });

  it("leaves jurisdiction-depth satisfied-present at/above threshold unchanged", () => {
    const result = applyDepthRailDisplayGate(baseCell({ honestCoveragePct: 99.77, isPartial: false }));
    expect(result.displayState).toBe("satisfied-present");
  });

  it("downgrades jurisdiction-depth satisfied-present with NULL coverage to not-yet", () => {
    expect(applyDepthRailDisplayGate(baseCell({ honestCoveragePct: null, isPartial: false })).displayState).toBe("not-yet");
  });

  it("does not override satisfied-absent on jurisdiction-depth rails", () => {
    expect(applyDepthRailDisplayGate(baseCell({ displayState: "satisfied-absent", honestCoveragePct: 0 })).displayState).toBe("satisfied-absent");
  });

  it("does not change statewide-uniform rails below threshold", () => {
    const result = applyDepthRailDisplayGate(baseCell({ railKey: "geometry", honestCoveragePct: 80, isPartial: true }));
    expect(result.displayState).toBe("satisfied-present");
    expect(result.isPartial).toBe(true);
  });
});
