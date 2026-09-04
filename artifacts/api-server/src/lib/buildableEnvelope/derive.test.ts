/**
 * Geometry-helper tests after anti-zombie cut: derive returns geometry only;
 * product confidence is null (never labeling×district multiply).
 */

import { describe, it, expect, vi } from "vitest";
import type { SetbackTable } from "@workspace/adapters";
import { feetToMeters, insetPerEdge, type Ring } from "./geometry";
import { labelEdges } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";

// Partial mock so the P60b reason-split test can force a gate rejection
// (unreachable with honest inputs now that the gates only fire on genuine
// violations); every other test runs the real insetPerEdge.
vi.mock("./geometry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./geometry")>();
  return { ...actual, insetPerEdge: vi.fn(actual.insetPerEdge) };
});

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

describe("deriveBuildableEnvelope — geometry helper (no product confidence)", () => {
  it("road front + matched district -> geometry, confidence null", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(false);
    expect(res.confidence).toBeNull();
    expect(res.citationUrl).toContain("municode");
    const feat = res.geojson.features[0]!;
    expect(feat.geometry).not.toBeNull();
    expect(feat.properties.notSurveyGrade).toBe(true);
    expect(feat.properties.buildableAreaSqFt).toBeGreaterThan(12_000);
    expect(feat.properties.maxFootprintSqFt).toBeCloseTo(8_000, -2);
    expect(feat.properties.disclosure).toMatch(/not survey grade/i);
  });

  it("shape signal -> approximate geometry, confidence still null", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: null, refPoint: null })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.approximate).toBe(true);
    expect(res.confidence).toBeNull();
    expect(res.geojson.features[0]!.properties.edgeSignal).toBe("shape");
  });

  it("setbacks exceed a tiny lot -> null geometry + honest consume-lot reason", () => {
    const ring = rectRing(40, 40);
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-LD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(true);
    expect(res.emptyKind).toBe("consumed");
    expect(res.confidence).toBeNull();
    const props = res.geojson.features[0]!;
    expect(props.geometry).toBeNull();
    expect(props.properties.emptyKind).toBe("consumed");
    expect(props.properties.disclosure).toMatch(/no buildable area/i);
    expect(props.properties.emptyReason).toMatch(/exceed the lot/i);
  });

  it("P60b reason split: gate rejection surfaces as validation decline, never consume-lot", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    vi.mocked(insetPerEdge).mockReturnValueOnce({
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt: 20_000,
      empty: true,
      emptyReason:
        "geometry validation failed (inset overlaps forbidden setback strips by 12.00 m² (ε 0.50))",
      emptyKind: "validation-failed",
    });
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(true);
    expect(res.emptyKind).toBe("validation-failed");
    const props = res.geojson.features[0]!.properties;
    expect(props.emptyKind).toBe("validation-failed");
    expect(props.emptyReason).toMatch(/geometry validation failed/i);
    expect(props.disclosure).toMatch(/geometry validation failed/i);
    expect(props.disclosure).not.toMatch(/exceed the lot/i);
  });

  it("not_specified side/rear (P-3 shape) does not consume the lot", () => {
    const p3Table: SetbackTable = {
      jurisdictionKey: "bastrop-city-tx",
      jurisdictionDisplayName: "Bastrop B3",
      districts: [
        {
          district_name: "P-3 Neighborhood",
          front_ft: 25,
          rear_ft: 0,
          side_ft: 0,
          side_corner_ft: 0,
          max_height_ft: 100,
          max_lot_coverage_pct: 50,
          max_impervious_pct: 100,
          citation_url: "https://example.test/b3",
          provenance: {
            front_ft: { not_specified: false },
            side_ft: { not_specified: true },
            rear_ft: { not_specified: true },
            side_corner_ft: { not_specified: true },
          },
        },
      ],
    };
    const ring = rectRing(100, 200);
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(p3Table, "P-3")!;
    const res = deriveBuildableEnvelope({
      ring,
      table: p3Table,
      district,
      labeling,
    });
    expect(res.empty).toBe(false);
    expect(res.geojson.features[0]!.geometry).not.toBeNull();
    expect(res.geojson.features[0]!.properties.setbacks.not_specified).toEqual({
      side: true,
      rear: true,
      side_corner: true,
    });
    expect(res.geojson.features[0]!.properties.disclosure).toMatch(/build-to-line/i);
    expect(res.geojson.features[0]!.properties.disclosure).not.toMatch(/consume/i);
  });
});
