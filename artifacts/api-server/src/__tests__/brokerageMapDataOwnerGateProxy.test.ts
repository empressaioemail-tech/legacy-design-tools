/**
 * The live leak's exact shape, with NO database: the hauska-map proxy's
 * service bearer and no user identity, `POST /map-data/gis-layer
 * {layer:"parcels", bbox}`. This caller resolves to the Max package tier
 * (service caller) and to NO owner-fact caller, so neither path touches the
 * DB — the suite runs anywhere, including hosts without PostGIS, and is the
 * falsifier for the leak: it fails on the pre-fix route, which returned
 * `owner` on every feature.
 *
 * The full entitlement matrix (identified-only / Solo / Studio / per-parcel
 * unlock / expired unlock) runs against a real test schema in
 * brokerageMapDataOwnerGate.test.ts. Synthetic fixtures only.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const SERVICE_TOKEN = "test-service-token-map-data-owner-proxy";
const SYNTH = "SYNTHETIC-GATED-VALUE";

vi.mock("../lib/brokerageGisLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisLayers")
  >("../lib/brokerageGisLayers");
  const parcel = (id: string) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    properties: {
      provider: "txgio",
      countyFips: "48999",
      apn: id,
      parcel_node_id: `48999:${id}`,
      situsAddress: "1 SYNTHETIC WAY",
      owner: SYNTH,
      ownerMailingAddress: SYNTH,
      landUseCode: "A1",
    },
  });
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(async () => ({
      layer: "parcels",
      provider: "synthetic",
      adapterKey: "synthetic:parcels",
      serviceUrl: "https://synthetic.invalid",
      featureCount: 3,
      queryMode: "bbox",
      geojson: {
        type: "FeatureCollection",
        features: [parcel("1"), parcel("2"), parcel("3")],
      },
    })),
  };
});

const { buildTestApp } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

let app: Express;

beforeAll(async () => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_API_KEYS = "brokerage-test-key-owner-proxy";
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
  app = await buildTestApp();
});

describe("map-data gis-layer parcels via the proxy's service bearer (anonymous end user)", () => {
  it("returns parcels with NO owner key on any feature", async () => {
    const res = await request(app)
      .post("/api/brokerage/v1/map-data/gis-layer")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({
        layer: "parcels",
        bbox: { west: -97.4, south: 30.0, east: -97.39, north: 30.01 },
      });
    expect(res.status).toBe(200);
    const fs = res.body.geojson.features as Array<{
      properties: Record<string, unknown>;
    }>;
    expect(fs).toHaveLength(3);
    const withOwner = fs.filter((f) => "owner" in f.properties).length;
    expect(withOwner).toBe(0);
    for (const f of fs) {
      expect("ownerMailingAddress" in f.properties).toBe(false);
      expect(f.properties.parcel_node_id).toBeTruthy();
      expect(f.properties.situsAddress).toBe("1 SYNTHETIC WAY");
    }
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });
});
