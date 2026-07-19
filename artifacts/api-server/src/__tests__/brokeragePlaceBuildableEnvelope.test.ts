/**
 * Route test for GET/POST /api/brokerage/v1/place[/:placeKey]/buildable-envelope.
 *
 * Mocks the two external calls (place geocode + parcel-polygon fetch + nearest
 * road) so the test is deterministic and offline: it asserts the route returns
 * the envelope GeoJSON + confidence + citation on a good parcel, marks it
 * approximate when the signals are weak, and 404s honestly when the jurisdiction
 * has no codified setback table.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { feetToMeters } from "../lib/buildableEnvelope/geometry";

const SERVICE_TOKEN = "test-service-token-be";
const BROKERAGE_KEY = "brokerage-test-key-be";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("brokeragePlaceBuildableEnvelope.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

// Geocode -> a fixed Bastrop point (bastrop-tx has a real setback table).
const BASTROP_LNG = -97.31;
const BASTROP_LAT = 30.11;
vi.mock("../lib/placeResolve", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/placeResolve")>(
      "../lib/placeResolve",
    );
  return {
    ...actual,
    resolvePlace: vi.fn(async (input: unknown) => {
      const i = input as { address?: string };
      // Route "Nowhere, XX" to a no-setback jurisdiction.
      const noSetback =
        typeof i.address === "string" && /nowhere/i.test(i.address);
      return {
        placeKey: `coord:${BASTROP_LAT}:${BASTROP_LNG}`,
        jurisdiction_key: null,
        ll_uuid: null,
        workspaceDid: null,
        geocode: {
          lat: BASTROP_LAT,
          lng: BASTROP_LNG,
          city: noSetback ? "Nowhere" : "Bastrop",
          state: noSetback ? "XX" : "TX",
          confidence: "high" as const,
        },
      };
    }),
  };
});

// A 100ft x 200ft rectangular parcel centered on the Bastrop point, zoned R-MD.
// `parcelNodeId` mirrors what the real parcel providers (county-GIS /
// txgio-store) stamp onto each feature's properties via the shared
// `parcelNodeId()` helper. When null (default), the feature carries NO
// `parcel_node_id` property, exactly as the dormant Cotality fallback path
// leaves it — so the route must surface a null id, never fabricate one.
function rectParcel(zoningCode: string | null, parcelNodeId: string | null = null) {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((BASTROP_LAT * Math.PI) / 180);
  const halfW = feetToMeters(100) / 2 / mPerDegLng;
  const halfH = feetToMeters(200) / 2 / mPerDegLat;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [BASTROP_LNG - halfW, BASTROP_LAT - halfH],
              [BASTROP_LNG + halfW, BASTROP_LAT - halfH],
              [BASTROP_LNG + halfW, BASTROP_LAT + halfH],
              [BASTROP_LNG - halfW, BASTROP_LAT + halfH],
              [BASTROP_LNG - halfW, BASTROP_LAT - halfH],
            ],
          ],
        },
        properties: {
          apn: "R123456",
          situsAddress: "1209 Main St",
          zoningCode,
          ...(parcelNodeId ? { parcel_node_id: parcelNodeId } : {}),
        },
      },
    ],
  };
}

let parcelZoning: string | null = "R-MD";
// Set per-test to simulate the provider having (or not having) stamped a
// tile-matching `parcel_node_id` on the resolved feature.
let parcelNodeIdStamped: string | null = null;
vi.mock("../lib/brokerageGisLayers", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/brokerageGisLayers")>(
      "../lib/brokerageGisLayers",
    );
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(async () => ({
      layer: "parcels",
      provider: "Test County GIS",
      adapterKey: "test:parcels",
      serviceUrl: "https://example/parcels",
      geojson: rectParcel(parcelZoning, parcelNodeIdStamped),
      featureCount: 1,
      queryMode: "pin" as const,
      notSurveyGrade: true,
    })),
  };
});

// Nearest road: an E-W street just south of the lot -> HIGH-confidence front.
vi.mock("../lib/buildableEnvelope/roads", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/buildableEnvelope/roads")>(
      "../lib/buildableEnvelope/roads",
    );
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = BASTROP_LAT - feetToMeters(120) / mPerDegLat;
  return {
    ...actual,
    fetchNearestRoads: vi.fn(async () => [
      [
        [BASTROP_LNG - 0.002, roadLat],
        [BASTROP_LNG + 0.002, roadLat],
      ],
    ]),
  };
});

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_API_KEYS = BROKERAGE_KEY;
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
});

function post(body: Record<string, unknown>) {
  return request(getApp())
    .post("/api/brokerage/v1/place/buildable-envelope")
    .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
    .send(body);
}

describe("POST /place/buildable-envelope", () => {
  it("returns an envelope with confidence + citation for a matched parcel", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.layer).toBe("buildable-envelope");
    // Envelope geometry present.
    const feat = res.body.payload.geojson.features[0];
    expect(feat.geometry.type).toBe("Polygon");
    // Honesty envelope.
    expect(res.body.confidence).toBeDefined();
    expect(res.body.confidence.value).toBeGreaterThan(0);
    expect(res.body.confidence.kind).toBe("asserted");
    // Citation present (Municode).
    expect(res.body.source.citationIds[0]).toMatch(/municode/i);
    expect(feat.properties.citationUrl).toMatch(/municode/i);
    expect(feat.properties.notSurveyGrade).toBe(true);
    expect(feat.properties.disclosure).toMatch(/not survey grade/i);
    // R-MD matched -> not approximate (road front + matched district).
    expect(res.body.payload.approximate).toBe(false);
  });

  it("marks approximate when zoning is absent (conservative fallback)", async () => {
    parcelZoning = null;
    parcelNodeIdStamped = null;
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.payload.approximate).toBe(true);
    const feat = res.body.payload.geojson.features[0];
    expect(feat.properties.disclosure).toMatch(/verify/i);
  });

  it("404s honestly when the jurisdiction has no setback table", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    const res = await post({ address: "1 Main St, Nowhere, XX" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-setbacks");
  });
});

describe("POST /place/buildable-envelope — parcel_node_id (canvas-free map snap)", () => {
  it("emits the tile-matching parcel_node_id on the ok path (top-level + payload.parcel)", async () => {
    parcelZoning = "R-MD";
    // The Hays 576 Sage Thrasher known case: Hays fips 48209, prop_id 123767
    // -> the parcel provider stamps parcel_node_id "48209:123767", which must
    // byte-match the PMTiles promoteId. The route reads it straight off the
    // resolved feature (no re-derivation).
    parcelNodeIdStamped = "48209:123767";
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // FE contract: uniform top-level field across all statuses.
    expect(res.body.parcel_node_id).toBe("48209:123767");
    // And inside the parcel identity block on the ok payload.
    expect(res.body.payload.parcel.parcel_node_id).toBe("48209:123767");
  });

  it("emits null (never fabricates) when the parcel source stamped no node id", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null; // e.g. dormant Cotality fallback / no prop id
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.parcel_node_id).toBeNull();
    expect(res.body.payload.parcel.parcel_node_id).toBeNull();
  });

  it("emits parcel_node_id on the no-setbacks path so the map still snaps + glows", async () => {
    // Dripping Springs shape: the parcel EXISTS but the jurisdiction has no
    // codified setback table -> status no-setbacks, yet the subject parcel must
    // still glow. parcel_node_id is gated on parcel resolution, NOT on setbacks.
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48209:123767";
    const res = await post({ address: "1 Main St, Nowhere, XX" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-setbacks");
    expect(res.body.parcel_node_id).toBe("48209:123767");
  });
});
