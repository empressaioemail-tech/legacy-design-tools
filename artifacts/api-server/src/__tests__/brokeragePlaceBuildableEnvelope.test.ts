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
import { AdapterRunError } from "@workspace/adapters/types";
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
// Per-test override of the geocoded point/city. F4e runs a best-effort
// geocode in the SITUS-FIRST pre-pass (via `geocodeAddress`) AND, on the
// no-situs fall-through, `resolvePlace` re-derives from the same geocode.
// Both mocks read this single override so a test controls the point/city
// once. `null` on `geocodeMiss` simulates a geocode MISS (the pre-pass
// then runs point-less; a unique situs still resolves — F4e item 3).
// Reset in beforeEach.
let geocodeOverride: {
  lat: number;
  lng: number;
  city: string;
  state: string;
  matchRung?: "street" | "locality" | "zip";
} | null = null;
let geocodeMiss = false;

// The SITUS-FIRST pre-pass geocode (best-effort, non-fatal). Returns the
// `Geocode` shape (`latitude`/`longitude`/`jurisdictionCity`/...), or null
// on a simulated miss.
vi.mock("@workspace/site-context/server", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/site-context/server")>(
      "@workspace/site-context/server",
    );
  return {
    ...actual,
    geocodeAddress: vi.fn(async (address: string) => {
      if (geocodeMiss) return null;
      const o = geocodeOverride;
      const noSetback = /nowhere/i.test(address);
      return {
        latitude: o?.lat ?? BASTROP_LAT,
        longitude: o?.lng ?? BASTROP_LNG,
        jurisdictionCity: o?.city ?? (noSetback ? "Nowhere" : "Bastrop"),
        jurisdictionState: o?.state ?? (noSetback ? "XX" : "TX"),
        matchRung: o?.matchRung,
        source: "nominatim" as const,
      };
    }),
  };
});

vi.mock("../lib/placeResolve", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/placeResolve")>(
      "../lib/placeResolve",
    );
  return {
    ...actual,
    resolvePlace: vi.fn(async (input: unknown) => {
      const i = input as { address?: string };
      const o = geocodeOverride;
      if (geocodeMiss && i.address) {
        return {
          errorClass: "geocode_miss" as const,
          error: "geocode_miss",
          message: "Could not geocode the provided address",
        };
      }
      // Route "Nowhere, XX" to a no-setback jurisdiction.
      const noSetback =
        typeof i.address === "string" && /nowhere/i.test(i.address);
      const lat = o?.lat ?? BASTROP_LAT;
      const lng = o?.lng ?? BASTROP_LNG;
      return {
        placeKey: `coord:${lat}:${lng}`,
        jurisdiction_key: null,
        ll_uuid: null,
        workspaceDid: null,
        geocode: {
          lat,
          lng,
          city: o?.city ?? (noSetback ? "Nowhere" : "Bastrop"),
          state: o?.state ?? (noSetback ? "XX" : "TX"),
          confidence: "high" as const,
          matchRung: o?.matchRung,
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
// Per-test control over the pin-query path: set to an AdapterRunError to
// simulate a provider failure vs. an empty-coverage (no parcel) throw,
// or record the point it was called with.
let pinQueryThrow: unknown = null;
let lastPinQueryPoint: { latitude?: number; longitude?: number } | null = null;
vi.mock("../lib/brokerageGisLayers", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/brokerageGisLayers")>(
      "../lib/brokerageGisLayers",
    );
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(
      async (input: { latitude?: number; longitude?: number }) => {
        lastPinQueryPoint = {
          latitude: input.latitude,
          longitude: input.longitude,
        };
        if (pinQueryThrow) throw pinQueryThrow;
        return {
          layer: "parcels",
          provider: "Test County GIS",
          adapterKey: "test:parcels",
          serviceUrl: "https://example/parcels",
          geojson: rectParcel(parcelZoning, parcelNodeIdStamped),
          featureCount: 1,
          queryMode: "pin" as const,
          notSurveyGrade: true,
        };
      },
    ),
  };
});

// The F4e authoritative disambiguating resolver + store direct-fetch. Off
// by default (`no-situs-match` -> fall through to the point path,
// preserving the existing tests); a test sets `situsOutcome` to exercise
// the situs hit / ambiguous-decline paths. `situsOutcome` mirrors the real
// `SitusResolveOutcome` shape.
type SitusOutcome =
  | {
      hit: { parcelNodeId: string; rawPropId: string; matchSource: "situs" };
      resolvedBy: "unique-situs" | "point-disambiguated";
    }
  | {
      hit: null;
      reason:
        | "no-situs-match"
        | "ambiguous-no-point"
        | "ambiguous-no-containing-candidate"
        | "ambiguous-multiple-containing-candidates";
      ambiguousCandidateCount?: number;
    };
let situsOutcome: SitusOutcome = { hit: null, reason: "no-situs-match" };
let rooftopHit:
  | { latitude: number; longitude: number; matchSource: "txgio-address" }
  | null = null;
let byPropIdResult: unknown = null;
vi.mock("../lib/txgioAddressResolve", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/txgioAddressResolve")>(
      "../lib/txgioAddressResolve",
    );
  return {
    ...actual,
    resolveParcelBySitusDisambiguated: vi.fn(async () => situsOutcome),
    resolveRooftopByAddress: vi.fn(async () => rooftopHit),
  };
});
vi.mock("../lib/txgioParcelStore", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/txgioParcelStore")>(
      "../lib/txgioParcelStore",
    );
  return {
    ...actual,
    queryTxgioParcelByPropId: vi.fn(async () => byPropIdResult),
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
    fetchNearbyRoads: vi.fn(async () => [
      {
        name: "Main St",
        highway: "residential",
        polyline: [
          [BASTROP_LNG - 0.002, roadLat],
          [BASTROP_LNG + 0.002, roadLat],
        ],
      },
    ]),
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

import { beforeEach } from "vitest";
beforeEach(() => {
  // Reset F4d/F4e controls so each test starts from the point-path baseline.
  pinQueryThrow = null;
  lastPinQueryPoint = null;
  situsOutcome = { hit: null, reason: "no-situs-match" };
  rooftopHit = null;
  byPropIdResult = null;
  geocodeOverride = null;
  geocodeMiss = false;
});

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
    // No-setbacks shape: the parcel EXISTS but the jurisdiction has no
    // codified setback table (here "Nowhere, XX") -> status no-setbacks, yet the
    // subject parcel must still glow. parcel_node_id is gated on parcel
    // resolution, NOT on setbacks.
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48209:123767";
    const res = await post({ address: "1 Main St, Nowhere, XX" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-setbacks");
    expect(res.body.parcel_node_id).toBe("48209:123767");
  });
});

describe("POST /place/buildable-envelope — F4d authoritative resolution", () => {
  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  it("HONORS explicit lat/lng and does NOT re-geocode the point (even with an address)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    // Pass a point that is NOT the Bastrop point the geocode mock would
    // return; the pin query must be called with the CALLER'S coords.
    const res = await postWith({
      address: "1209 Main St, Bastrop, TX 78602",
      lat: 30.04667,
      lng: -97.81298,
    });
    expect(res.status).toBe(200);
    expect(lastPinQueryPoint).toEqual({
      latitude: 30.04667,
      longitude: -97.81298,
    });
  });

  it("classifies an empty-coverage throw as an honest 404 no-parcel (NOT a 502)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    // The store/provider readers throw AdapterRunError("no-coverage") when
    // the query succeeded but no parcel matched — this is the geocode-miss
    // / point-outside-every-polygon case that used to masquerade as a 502.
    pinQueryThrow = new AdapterRunError(
      "no-coverage",
      "no ingested parcel polygons for this query",
    );
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-parcel");
    expect(res.body.parcel_node_id).toBeNull();
  });

  it("still returns a real 502 for a GENUINE provider failure (network/upstream)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    pinQueryThrow = new AdapterRunError(
      "upstream-error",
      "county ArcGIS service returned HTTP 500",
    );
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("parcel-unavailable");
  });

  it("uses the authoritative situs short-circuit for a Hays store-backed county", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    // Geocode returns a Hays point (Wimberley) so the county resolves to the
    // txgio-store-backed Hays; the situs resolver returns a UNIQUE hit,
    // and the store returns that parcel's geometry by prop id. Wimberley is a
    // Hays city with NO codified setback table (Dripping Springs / Kyle / Buda
    // gained tables in F4k), which is exactly what this test needs to exercise
    // the no-setbacks-yet-parcel-resolved shape.
    geocodeOverride = {
      lat: 29.99741,
      lng: -98.09836,
      city: "Wimberley",
      state: "TX",
      matchRung: "street",
    };
    situsOutcome = {
      hit: {
        parcelNodeId: "48209:193340",
        rawPropId: "193340",
        matchSource: "situs",
      },
      resolvedBy: "unique-situs",
    };
    byPropIdResult = {
      geojson: rectParcel("R-MD", "48209:193340"),
      featureCount: 1,
      queryMode: "pin" as const,
    };
    const res = await postWith({ address: "300 Blanco River Rd, Wimberley, TX 78676" });
    // Wimberley (Hays) has no codified setback table, so the envelope itself
    // is an honest no-setbacks 404 — but the AUTHORITATIVE situs
    // short-circuit still resolved the SUBJECT PARCEL, so parcel_node_id
    // is populated (the map can snap + glow). That the id is present is
    // the proof the situs path resolved the right parcel.
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-setbacks");
    expect(res.body.parcel_node_id).toBe("48209:193340");
    // The point pin-query must NOT have been consulted — the situs path
    // short-circuited it.
    expect(lastPinQueryPoint).toBeNull();
  });

  it("declines to resolve from a geocode CENTROID (locality/zip rung) — honest 404, no pin-query", async () => {
    // The address only geocoded to a ZIP/city centroid (matchRung !=
    // "street") and neither authoritative path (situs/rooftop) matched.
    // Pin-querying a centroid is what resolved the WRONG parcel before —
    // fail honestly instead, and NEVER consult the pin query.
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    situsOutcome = { hit: null, reason: "no-situs-match" };
    rooftopHit = null; // no authoritative upgrade
    geocodeOverride = {
      lat: BASTROP_LAT,
      lng: BASTROP_LNG,
      city: "Bastrop",
      state: "TX",
      matchRung: "zip", // centroid, not rooftop
    };
    const res = await postWith({ address: "9999 Rural Rd, Bastrop, TX 78602" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-parcel");
    expect(res.body.parcel_node_id).toBeNull();
    // The centroid must NOT have been pin-queried.
    expect(lastPinQueryPoint).toBeNull();
  });

  it("still returns a full 200 envelope through the point path (no regression)", async () => {
    // The default point path (no situs short-circuit) still flows all the
    // way to a 200 envelope for a jurisdiction WITH a setback table
    // (bastrop-tx) — the F4d changes are additive and don't regress it.
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    situsOutcome = { hit: null, reason: "no-situs-match" }; // point path
    geocodeOverride = null; // Bastrop (has setbacks)
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
