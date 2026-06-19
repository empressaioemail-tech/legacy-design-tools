import { describe, expect, it, vi } from "vitest";
import { foundationRiskScoreFromShrinkSwell } from "@workspace/adapters/federal/usda-ssurgo";
import {
  enrichSsurgoGeoJson,
  filterMudPidFeatures,
  federalGisLayerFixtureGeoJson,
  isFederalGisProxyLayer,
  listFederalGisLayerEndpoints,
  scoreSsurgoFeatureRisk,
} from "../brokerageGisFederalLayers";
import { __resetTxSpecialDistrictCacheForTests } from "../mudPidRegistry";

describe("isFederalGisProxyLayer", () => {
  it("recognizes Track 2 federal layer keys", () => {
    expect(isFederalGisProxyLayer("ssurgo-soils")).toBe(true);
    expect(isFederalGisProxyLayer("texas-rrc")).toBe(true);
    expect(isFederalGisProxyLayer("parcels")).toBe(false);
  });
});

describe("listFederalGisLayerEndpoints", () => {
  it("registers five free federal proxy layers", () => {
    const keys = listFederalGisLayerEndpoints().map((l) => l.layer);
    expect(keys).toEqual([
      "ssurgo-soils",
      "groundwater",
      "mud-pid",
      "edwards-aquifer",
      "texas-rrc",
    ]);
  });
});

describe("foundation risk scoring", () => {
  it("maps shrink-swell interp to 1..5 risk score", () => {
    expect(foundationRiskScoreFromShrinkSwell("Moderate")).toBe(3);
    expect(foundationRiskScoreFromShrinkSwell("High")).toBe(4);
    expect(foundationRiskScoreFromShrinkSwell("None")).toBe(1);
  });

  it("enriches gSSURGO features with foundationRiskScore", () => {
    const enriched = enrichSsurgoGeoJson({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [] },
          properties: { shrinkswell: "High", MUSYM: "Pf" },
        },
      ],
    });
    const props = (enriched.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect(props.foundationRiskScore).toBe(4);
    expect(props.foundationRiskBand).toBe("high");
  });

  it("falls back to hydrologic group when shrink-swell absent", () => {
    expect(
      scoreSsurgoFeatureRisk({ hydgrpdcd: "D" }),
    ).toBeGreaterThanOrEqual(4);
  });
});

describe("filterMudPidFeatures", () => {
  it("keeps MUD/PID district polygons and tags registry match", () => {
    __resetTxSpecialDistrictCacheForTests();
    const filtered = filterMudPidFeatures({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { NAME: "Sample Travis MUD No. 1", TYPE: "MUD" },
        },
        {
          type: "Feature",
          properties: { NAME: "Irrigation District", TYPE: "IRR" },
        },
      ],
    });
    expect(filtered.features).toHaveLength(1);
    const props = (filtered.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect(props.districtType).toBe("MUD");
    expect(props.registryMatch).toBe(true);
  });
});

describe("federalGisLayerFixtureGeoJson", () => {
  const bbox = {
    westLng: -97.32,
    southLat: 30.1,
    eastLng: -97.3,
    northLat: 30.12,
  };

  it("returns synthetic groundwater points", () => {
    const fc = federalGisLayerFixtureGeoJson("groundwater", bbox);
    expect(fc.features).toHaveLength(1);
    expect(
      (fc.features[0] as { geometry: { type: string } }).geometry.type,
    ).toBe("Point");
  });

  it("returns synthetic texas-rrc wells and pipelines", () => {
    const fc = federalGisLayerFixtureGeoJson("texas-rrc", bbox);
    expect(fc.features.length).toBeGreaterThanOrEqual(2);
  });
});

describe("queryFederalGisLayerGeoJson", () => {
  it("parses NWIS expanded site JSON into point features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: {
              timeSeries: [
                {
                  sourceInfo: {
                    siteName: "Test GW",
                    siteCode: [{ value: "293801097320001" }],
                    geoLocation: {
                      geogLocation: { latitude: "30.1105", longitude: "-97.3186" },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );
    const result = await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: {
        westLng: -97.4,
        southLat: 30.0,
        eastLng: -97.2,
        northLat: 30.2,
      },
    });
    expect(result.featureCount).toBe(1);
    expect(result.geojson.features[0]).toMatchObject({
      geometry: { type: "Point" },
    });
    vi.unstubAllGlobals();
  });
});
