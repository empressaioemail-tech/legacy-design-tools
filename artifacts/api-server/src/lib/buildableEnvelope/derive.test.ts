/**
 * Derivation/honesty-composition tests (Problem C): a high-confidence envelope
 * (road front + matched district) vs an approximate one (no signal + fallback
 * district), and the empty case. Verifies confidence, the approximate flag, the
 * disclosure, and the downstream sizing fields.
 */

import { describe, it, expect } from "vitest";
import type { SetbackTable } from "@workspace/adapters";
import { feetToMeters, type Ring } from "./geometry";
import { labelEdges } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";

const LNG0 = -97.31;
const LAT0 = 30.11;

function rectRing(wFt = 100, hFt = 200): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const halfW = feetToMeters(wFt) / 2 / mPerDegLng;
  const halfH = feetToMeters(hFt) / 2 / mPerDegLat;
  return [
    [LNG0 - halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 - halfH],
  ];
}

const TABLE: SetbackTable = {
  jurisdictionKey: "test-tx",
  jurisdictionDisplayName: "Test, TX",
  districts: [
    {
      district_name: "R-MD Residential Medium Density",
      front_ft: 25,
      rear_ft: 20,
      side_ft: 7.5,
      side_corner_ft: 15,
      max_height_ft: 35,
      max_lot_coverage_pct: 40,
      max_impervious_pct: 55,
      citation_url: "https://library.municode.com/tx/test",
    },
    {
      district_name: "R-LD Residential Low Density",
      front_ft: 30,
      rear_ft: 25,
      side_ft: 10,
      side_corner_ft: 20,
      max_height_ft: 35,
      max_lot_coverage_pct: 35,
      max_impervious_pct: 50,
      citation_url: "https://library.municode.com/tx/test",
    },
  ],
};

function roadSouthOf(): [number, number][] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = LAT0 - feetToMeters(120) / mPerDegLat;
  return [
    [LNG0 - 0.002, roadLat],
    [LNG0 + 0.002, roadLat],
  ];
}

describe("deriveBuildableEnvelope — high confidence", () => {
  it("road front + matched district -> not approximate, cited", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(false);
    expect(res.approximate).toBe(false);
    expect(res.confidence).toBeGreaterThanOrEqual(0.7);
    expect(res.citationUrl).toContain("municode");
    const feat = res.geojson.features[0]!;
    expect(feat.geometry).not.toBeNull();
    expect(feat.properties.notSurveyGrade).toBe(true);
    // Buildable ~ (100-15)x(200-45) = 13,175.
    expect(feat.properties.buildableAreaSqFt).toBeGreaterThan(12_000);
    expect(feat.properties.buildableAreaSqFt).toBeLessThan(14_000);
    // Downstream sizing: max footprint capped by 40% lot coverage of ~20,000 =
    // 8,000, which is SMALLER than the 13,175 envelope -> coverage cap wins.
    expect(feat.properties.maxFootprintSqFt).toBeCloseTo(8_000, -2);
    expect(feat.properties.maxHeightFt).toBe(35);
    // Disclosure always warns "not survey grade".
    expect(feat.properties.disclosure).toMatch(/not survey grade/i);
  });
});

describe("deriveBuildableEnvelope — approximate", () => {
  it("no signal + fallback district -> approximate + verify disclosure", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: null, refPoint: null })!; // shape
    const district = mapDistrict(TABLE, "UNKNOWN-CODE")!; // fallback
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.approximate).toBe(true);
    expect(res.confidence).toBeLessThan(0.7);
    const feat = res.geojson.features[0]!;
    expect(feat.properties.approximate).toBe(true);
    expect(feat.properties.disclosure).toMatch(/approximate/i);
    expect(feat.properties.disclosure).toMatch(/verify/i);
    expect(feat.properties.edgeSignal).toBe("shape");
  });
});

describe("deriveBuildableEnvelope — empty", () => {
  it("setbacks exceed a tiny lot -> null geometry + honest reason", () => {
    const ring = rectRing(40, 40); // 40x40 lot
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-LD")!; // 30/25/10 setbacks
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(true);
    expect(res.approximate).toBe(true);
    const feat = res.geojson.features[0]!;
    expect(feat.geometry).toBeNull();
    expect(feat.properties.buildableAreaSqFt).toBe(0);
    expect(feat.properties.emptyReason).toBeTruthy();
    expect(feat.properties.disclosure).toMatch(/no buildable area/i);
  });
});
