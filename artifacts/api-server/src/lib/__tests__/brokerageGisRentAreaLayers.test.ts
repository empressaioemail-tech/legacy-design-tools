import { describe, expect, it } from "vitest";
import {
  ACS_RENT_DISCLOSURE,
  parseAcsTractRentRows,
} from "@workspace/adapters/federal/census-acs-rent";
import {
  RENT_AREA_LAYER_KEY,
  enrichRentAreaFeatures,
  isRentAreaLayer,
  listRentAreaLayerEndpoints,
  rentAreaLayerFixtureResult,
  tractGeoidFromProps,
} from "../brokerageGisRentAreaLayers";

describe("isRentAreaLayer", () => {
  it("recognizes only the rent-area key", () => {
    expect(isRentAreaLayer(RENT_AREA_LAYER_KEY)).toBe(true);
    expect(isRentAreaLayer("rent-area-acs")).toBe(true);
    expect(isRentAreaLayer("parcels")).toBe(false);
    expect(isRentAreaLayer("ssurgo-soils")).toBe(false);
  });
});

describe("listRentAreaLayerEndpoints", () => {
  it("registers one public area-rent layer with the honesty description", () => {
    const endpoints = listRentAreaLayerEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.layer).toBe("rent-area-acs");
    expect(endpoints[0]!.serviceUrl).toContain(
      "tigerweb.geo.census.gov",
    );
    expect(endpoints[0]!.description).toContain(
      "not property-level market rent",
    );
  });
});

describe("tractGeoidFromProps", () => {
  it("reads a valid 11-digit GEOID directly", () => {
    expect(tractGeoidFromProps({ GEOID: "48453000100" })).toBe(
      "48453000100",
    );
  });
  it("reconstructs from STATE/COUNTY/TRACT parts", () => {
    expect(
      tractGeoidFromProps({ STATE: "48", COUNTY: "453", TRACT: "000100" }),
    ).toBe("48453000100");
  });
  it("returns null when no tract identity is present", () => {
    expect(tractGeoidFromProps({ FOO: "bar" })).toBeNull();
    expect(tractGeoidFromProps(undefined)).toBeNull();
  });
});

describe("parseAcsTractRentRows", () => {
  it("joins rent by 11-digit GEOID and drops ACS suppression sentinels", () => {
    const matrix = [
      ["NAME", "B25064_001E", "B25064_001M", "state", "county", "tract"],
      ["Census Tract 1, Travis", "1650", "120", "48", "453", "000100"],
      ["Census Tract 2, Travis", "-666666666", "-555555555", "48", "453", "000200"],
    ];
    const map = parseAcsTractRentRows(matrix);
    expect(map.get("48453000100")?.medianGrossRent).toBe(1650);
    expect(map.get("48453000100")?.marginOfError).toBe(120);
    // Suppressed tract keeps its geometry key but null rent (never fabricated).
    expect(map.get("48453000200")?.medianGrossRent).toBeNull();
  });
  it("returns an empty map for a malformed response", () => {
    expect(parseAcsTractRentRows(null).size).toBe(0);
    expect(parseAcsTractRentRows([["header only"]]).size).toBe(0);
  });
});

describe("enrichRentAreaFeatures — mandatory disclosure guardrail", () => {
  const provenance = {
    disclosure: ACS_RENT_DISCLOSURE,
    source: "U.S. Census Bureau, ACS 2023 5-Year, table B25064, tract level",
    table: "B25064",
    vintage: 2023,
    confidence: { value: 0.6, kind: "asserted-with-provenance" as const },
    timestamp: new Date().toISOString(),
    operatorDataPullRequired: false,
  };

  it("stamps the disclosure + provenance on EVERY painted feature", () => {
    const enriched = enrichRentAreaFeatures({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [] },
            properties: { GEOID: "48453000100" },
          },
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [] },
            properties: { GEOID: "48453000200" },
          },
        ],
      },
      rentByGeoid: new Map([
        ["48453000100", { geoid: "48453000100", medianGrossRent: 1650, marginOfError: 120 }],
      ]),
      provenance,
    });
    expect(enriched.features).toHaveLength(2);
    for (const f of enriched.features) {
      const props = (f as { properties: Record<string, unknown> }).properties;
      // The disclosure is present on every feature — the commitment-#1 guarantee.
      expect(props.rentAreaDisclosure).toBe(
        "area estimate, not property-level market rent",
      );
      expect(props.rentAreaSource).toContain("B25064");
      expect(props.rentAreaVintage).toBe(2023);
      expect(props.rentAreaConfidence).toEqual({
        value: 0.6,
        kind: "asserted-with-provenance",
      });
      expect(typeof props.rentAreaTimestamp).toBe("string");
    }
    // First tract carries its joined rent; second (no ACS row) stays null.
    const first = (enriched.features[0] as { properties: Record<string, unknown> })
      .properties;
    const second = (enriched.features[1] as { properties: Record<string, unknown> })
      .properties;
    expect(first.medianGrossRent).toBe(1650);
    expect(second.medianGrossRent).toBeNull();
  });
});

describe("rentAreaLayerFixtureResult", () => {
  it("returns a disclosed fixture tract with provenance mirrored top-level", () => {
    const result = rentAreaLayerFixtureResult({
      westLng: -97.85,
      southLat: 30.2,
      eastLng: -97.6,
      northLat: 30.4,
    });
    expect(result.layer).toBe("rent-area-acs");
    expect(result.disclosure).toBe(
      "area estimate, not property-level market rent",
    );
    expect(result.provenance.disclosure).toBe(result.disclosure);
    expect(result.featureCount).toBe(1);
    const props = (result.geojson.features[0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props.fixture).toBe(true);
    expect(props.rentAreaDisclosure).toBe(result.disclosure);
  });
});
