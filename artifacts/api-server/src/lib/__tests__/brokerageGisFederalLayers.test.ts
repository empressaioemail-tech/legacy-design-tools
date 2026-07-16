import { describe, expect, it, vi } from "vitest";

// The federal layer module now imports ./brokerageGisCache for its
// read-through cache, and that module loads @workspace/db (which throws
// without DATABASE_URL). Mock the cache to a no-op miss so these
// upstream-parsing tests run without a DB and exercise the live-fetch path
// (cache always misses -> always fetches). Same pattern as
// brokerageGisLayers.test.ts.
vi.mock("../brokerageGisCache", () => ({
  tileKey: vi.fn(
    (layer: string) => `${layer}:test-key`,
  ),
  getSpatialTile: vi.fn(async () => null),
  putSpatialTile: vi.fn(async () => {}),
}));

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

  it("serves ssurgo-soils from the SDA WFS host, no longer statically degraded", () => {
    const ssurgo = listFederalGisLayerEndpoints().find(
      (l) => l.layer === "ssurgo-soils",
    );
    expect(ssurgo?.degraded).toBeUndefined();
    expect(ssurgo?.serviceUrl).toContain("sdmdataaccess.sc.egov.usda.gov");
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
  it("parses NWIS RDB site rows into point features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `#
#
agency_cd	site_no	station_nm	site_tp_cd	dec_lat_va	dec_long_va
5s	15s	50s	7s	16s	16s
USGS	293801097320001	Test GW	GW	30.1105	-97.3186
`,
          { status: 200, headers: { "content-type": "text/plain" } },
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

  it("serves ssurgo-soils polygons from the SDA WFS with SDA attribute enrichment", async () => {
    // Trimmed from a verbatim live SDA WFS response (2026-07-14):
    // GML2, <gml:coordinates> pairs are lat,lng.
    const wfsGml = `<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:wfs="http://www.opengis.net/wfs" xmlns:gml="http://www.opengis.net/gml">
  <gml:featureMember>
    <ms:mapunitpoly>
      <ms:mupolygonkey>558575913</ms:mupolygonkey>
      <ms:areasymbol>TX604</ms:areasymbol>
      <ms:musym>Oa</ms:musym>
      <ms:nationalmusym>2t26q</ms:nationalmusym>
      <ms:mukey>393475</ms:mukey>
      <ms:muareaacres>21.5</ms:muareaacres>
      <ms:multiPolygon>
        <gml:MultiPolygon srsName="EPSG:4326">
          <gml:polygonMember>
            <gml:Polygon>
              <gml:outerBoundaryIs>
                <gml:LinearRing>
                  <gml:coordinates>29.8710,-97.9320 29.8710,-97.9245 29.8772,-97.9245 29.8772,-97.9320 29.8710,-97.9320</gml:coordinates>
                </gml:LinearRing>
              </gml:outerBoundaryIs>
            </gml:Polygon>
          </gml:polygonMember>
        </gml:MultiPolygon>
      </ms:multiPolygon>
    </ms:mapunitpoly>
  </gml:featureMember>
</wfs:FeatureCollection>`;
    const sdaAttrs = {
      Table: [
        ["mukey", "muname", "compname", "drainagecl", "hydgrp", "comppct_r", "shrinkswell"],
        ["393475", "Oakalla silty clay loam", "Oakalla", "Well drained", "B", "90", "High"],
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes(".wfs")) {
          return new Response(wfsGml, {
            status: 200,
            headers: { "content-type": "text/xml" },
          });
        }
        if (url.includes("post.rest")) {
          return new Response(JSON.stringify(sdaAttrs), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );
    const result = await queryFederalGisLayerGeoJson({
      layer: "ssurgo-soils",
      bbox: {
        westLng: -97.932,
        southLat: 29.871,
        eastLng: -97.9245,
        northLat: 29.8772,
      },
    });
    expect(result.featureCount).toBe(1);
    const feature = result.geojson.features[0] as {
      geometry: { type: string; coordinates: number[][][][] };
      properties: Record<string, unknown>;
    };
    expect(feature.geometry.type).toBe("MultiPolygon");
    // lat,lng wire pairs must come back as GeoJSON [lng, lat].
    expect(feature.geometry.coordinates[0][0][0]).toEqual([-97.932, 29.871]);
    expect(feature.properties.mukey).toBe("393475");
    expect(feature.properties.muname).toBe("Oakalla silty clay loam");
    expect(feature.properties.shrinkswell).toBe("High");
    expect(feature.properties.foundationRiskScore).toBe(4);
    expect(feature.properties.foundationRiskBand).toBe("high");
    vi.unstubAllGlobals();
  });

  it("falls back to the gSSURGO ArcGIS host when the SDA WFS is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes(".wfs")) {
          throw new TypeError("fetch failed: ECONNRESET");
        }
        if (url.includes("nrcsgeoservices") && url.includes("/query")) {
          return new Response(
            JSON.stringify({
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: { type: "Polygon", coordinates: [] },
                  properties: { MUSYM: "Pf", shrinkswell: "Moderate" },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );
    const result = await queryFederalGisLayerGeoJson({
      layer: "ssurgo-soils",
      bbox: {
        westLng: -97.932,
        southLat: 29.871,
        eastLng: -97.9245,
        northLat: 29.8772,
      },
    });
    expect(result.featureCount).toBe(1);
    const props = (
      result.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    expect(props.foundationRiskScore).toBe(3);
    vi.unstubAllGlobals();
  });
});
