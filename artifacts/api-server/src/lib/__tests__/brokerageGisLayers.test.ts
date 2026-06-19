import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../brokerageGisCache", () => ({
  tileKey: vi.fn(),
  normalizeAddrKey: vi.fn(),
  getSpatialTile: vi.fn(async () => null),
  putSpatialTile: vi.fn(async () => {}),
  getPropertyAttr: vi.fn(async () => null),
  putPropertyAttr: vi.fn(async () => {}),
  getGeocodeClip: vi.fn(async () => null),
  putGeocodeClip: vi.fn(async () => {}),
}));

import { normalizeGisLayerBbox, buildParcelsGeoJsonFromSpatialRows } from "../brokerageGisLayers";

describe("normalizeGisLayerBbox", () => {
  it("accepts westLng/southLat/eastLng/northLat", () => {
    expect(
      normalizeGisLayerBbox({
        westLng: -97.32,
        southLat: 30.1,
        eastLng: -97.3,
        northLat: 30.12,
      }),
    ).toEqual({
      westLng: -97.32,
      southLat: 30.1,
      eastLng: -97.3,
      northLat: 30.12,
    });
  });

  it("accepts west/south/east/north aliases", () => {
    expect(
      normalizeGisLayerBbox({
        west: -97.32,
        south: 30.1,
        east: -97.3,
        north: 30.12,
      }),
    ).toEqual({
      westLng: -97.32,
      southLat: 30.1,
      eastLng: -97.3,
      northLat: 30.12,
    });
  });

  it("accepts xmin/ymin/xmax/ymax aliases", () => {
    expect(
      normalizeGisLayerBbox({
        xmin: -97.32,
        ymin: 30.1,
        xmax: -97.3,
        ymax: 30.12,
      }),
    ).toEqual({
      westLng: -97.32,
      southLat: 30.1,
      eastLng: -97.3,
      northLat: 30.12,
    });
  });
});

describe("buildParcelsGeoJsonFromSpatialRows geocode bridge", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.COTALITY_PROPERTY_KEY = process.env.COTALITY_PROPERTY_KEY;
    saved.COTALITY_PROPERTY_SECRET = process.env.COTALITY_PROPERTY_SECRET;
    process.env.COTALITY_PROPERTY_KEY = "prop-key";
    process.env.COTALITY_PROPERTY_SECRET = "prop-secret";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("enriches spatial rows via stdAddr geocode when clip is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/oauth/token")) {
          return new Response(
            JSON.stringify({ access_token: "property-token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/search/geocode")) {
          return new Response(JSON.stringify({ items: [{ clip: "5849283465" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/site-location")) {
          return new Response(
            JSON.stringify({
              landUseAndZoningCodes: {
                zoningCode: "P-2",
                zoningDescription: "Single-family residential",
                landUseCode: "1100",
                landUseDescription: "Residential",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/home-owners-association")) {
          return new Response(
            JSON.stringify({ hoaName: "Cool Water HOA", hoaFee: 125 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/comparables")) {
          return new Response(
            JSON.stringify({ comparables: [{ clip: "1" }, { clip: "2" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("unexpected", { status: 404 });
      }),
    );

    const built = await buildParcelsGeoJsonFromSpatialRows({
      rows: [
        {
          stdAddr: "251 Cool Water Dr",
          stdCity: "Bastrop",
          stdState: "TX",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-97.3154, 30.1107],
                [-97.315, 30.1107],
                [-97.315, 30.1111],
                [-97.3154, 30.1111],
                [-97.3154, 30.1107],
              ],
            ],
          },
        },
      ],
      bbox: {
        westLng: -97.32,
        southLat: 30.1,
        eastLng: -97.3,
        northLat: 30.12,
      },
    });

    const props = built.geojson.features[0] as {
      properties: Record<string, unknown>;
    };
    expect(props.properties.zoningCode).toBe("P-2");
    expect(props.properties.landUseCode).toBe("1100");
    expect(props.properties.hasHoaOnRecord).toBe(true);
    expect(props.properties.noHoaOnRecord).toBe(false);
    expect(props.properties.hoaName).toBe("Cool Water HOA");
    expect(props.properties.comparableCount).toBe(2);
  });
});
