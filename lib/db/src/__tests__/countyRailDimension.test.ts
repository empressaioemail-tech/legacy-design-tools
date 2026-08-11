import { describe, it, expect } from "vitest";
import {
  COUNTY_RAIL_STATIC_DECLARATION,
  COUNTY_RAIL_STATIC_COUNT,
  STATIC_COVERAGE_CLASS_BY_RAIL_KEY,
} from "../schema/countyRailStatic";
import { buildEffectiveCountyRailDeclaration } from "../railManifestDerivation";

const mockExists = (p: string) =>
  p.includes("write-") ||
  p.includes("countyGeometryScoreCli") ||
  p.includes("countyCoverageScoreCli") ||
  p.includes("hauska-engine");

describe("COUNTY_RAIL_STATIC_DECLARATION", () => {
  it("has 14 rails with ordinals 1..14", () => {
    expect(COUNTY_RAIL_STATIC_DECLARATION).toHaveLength(14);
    expect(COUNTY_RAIL_STATIC_COUNT).toBe(14);
    const ordinals = COUNTY_RAIL_STATIC_DECLARATION.map((r) => r.ordinal).sort(
      (a, b) => a - b,
    );
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("maps coverageClass for depth vs uniform rails", () => {
    expect(STATIC_COVERAGE_CLASS_BY_RAIL_KEY.cad).toBe("jurisdiction-depth");
    expect(STATIC_COVERAGE_CLASS_BY_RAIL_KEY.geometry).toBe("statewide-uniform");
  });
});

describe("buildEffectiveCountyRailDeclaration", () => {
  const effective = buildEffectiveCountyRailDeclaration({
    fileExists: mockExists,
    requireEngineRoot: false,
  });
  const byKey = new Map(effective.map((r) => [r.railKey, r]));

  it("derives CP1 rails from engine snapshot", () => {
    expect(byKey.get("owner")?.hasWriter).toBe(true);
    expect(byKey.get("rail-corridor")?.atomFamilyState).toBe("present");
    expect(byKey.get("rrc-wells")?.hasWriter).toBe(true);
    expect(byKey.get("mud")?.hasWriter).toBe(true);
    expect(byKey.get("footprint")?.hasWriter).toBe(true);
    expect(byKey.get("rrc-pipelines")?.atomFamilyState).toBe("missing");
    expect(byKey.get("easement")?.hasWriter).toBe(false);
  });
});
