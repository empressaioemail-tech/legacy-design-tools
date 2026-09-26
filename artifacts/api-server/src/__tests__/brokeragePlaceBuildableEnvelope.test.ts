/**
 * Route test for GET/POST /api/brokerage/v1/place[/:placeKey]/buildable-envelope.
 *
 * Mocks the two external calls (place geocode + parcel-polygon fetch + nearest
 * road) so the test is deterministic and offline: it asserts the route returns
 * the envelope GeoJSON + confidence + citation on a good parcel, marks it
 * approximate when the signals are weak, and 404s honestly when the jurisdiction
 * has no codified setback table.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { AdapterRunError } from "@workspace/adapters/types";
import { ctx } from "./test-context";
import { feetToMeters } from "../lib/buildableEnvelope/geometry";
import { DEPTH_WARM_PROMOTION_MARKER } from "../lib/buildableEnvelope/reconcileAtomEnvelope";
import { placeKeyFromCoords, roundPlaceCoord } from "../lib/placeLayerUtils";
import { resolveRooftopByAddress } from "../lib/txgioAddressResolve";

const SERVICE_TOKEN = "test-service-token-be";
const BROKERAGE_KEY = "brokerage-test-key-be";

const fetchPropertyAtomChainMock = vi.fn<() => Promise<unknown>>();
vi.mock("../lib/buildableEnvelope/fetchPropertyAtomChain", () => ({
  fetchPropertyAtomChain: () => fetchPropertyAtomChainMock(),
}));

vi.mock("@workspace/db", async () => {
  process.env.DATABASE_URL ||=
    "postgresql://p465-test:p465-test@127.0.0.1:5432/p465_test_offline";
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
function rectParcel(
  zoningCode: string | null,
  parcelNodeId: string | null = null,
  situsAddress = "1209 Main St",
) {
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
          situsAddress,
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
let parcelSitusAddress = "1209 Main St";
// Per-test control over the pin-query path: set to an AdapterRunError to
// simulate a provider failure vs. an empty-coverage (no parcel) throw,
// or record the point it was called with.
let pinQueryThrow: unknown = null;
// P-151: when true, the pin-query mock returns a promise that never settles
// -- simulating a stuck/orphaned query (e.g. DB pool contention) so the
// route's POINT_RESOLUTION_TIMEOUT_MS race can be exercised deterministically
// (with fake timers) instead of sleeping for real.
let pinQueryHang = false;
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
        if (pinQueryHang) return new Promise(() => {});
        if (pinQueryThrow) throw pinQueryThrow;
        return {
          layer: "parcels",
          provider: "Test County GIS",
          adapterKey: "test:parcels",
          serviceUrl: "https://example/parcels",
          geojson: rectParcel(
            parcelZoning,
            parcelNodeIdStamped,
            parcelSitusAddress,
          ),
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
// P-373: the route resolves a parcel by IDENTITY through
// `queryTxCountyParcelByPropId` (store-backed or live-ArcGIS, chosen from
// the county's own registry entry) — the seam a posted `parcel_node_id`
// and the authoritative situs hit both go through now. Mocked at that
// boundary: by default it answers the per-test deterministic parcel,
// stamped with the CANONICAL node id of the identity it was asked for
// (which is exactly what the real county sources stamp).
let identityFetchResult: unknown = null;
let identityFetchMissing = false;
let identityFetchThrow: unknown = null;
let lastIdentityFetch: { fips: string; propId: string } | null = null;
vi.mock("../lib/brokerageTxParcels", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/brokerageTxParcels")>(
      "../lib/brokerageTxParcels",
    );
  return {
    ...actual,
    queryTxCountyParcelByPropId: vi.fn(
      async (input: { county: { fips: string }; propId: string }) => {
        lastIdentityFetch = {
          fips: input.county.fips,
          propId: input.propId,
        };
        if (identityFetchThrow) throw identityFetchThrow;
        if (identityFetchMissing) return null;
        if (identityFetchResult) return identityFetchResult;
        return {
          geojson: rectParcel(
            parcelZoning,
            `${input.county.fips}:${input.propId}`,
            parcelSitusAddress,
          ),
          featureCount: 1,
          queryMode: "pin" as const,
        };
      },
    ),
  };
});

// (P-373) The store reader is no longer called by the route directly: the
// identity/situs paths go through `queryTxCountyParcelByPropId` above, which
// chooses the county's source. No `txgioParcelStore` mock is needed here.

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

const resolveSpineZoningWhenGisAbsentMock = vi.hoisted(() => vi.fn());
const recordJurisdictionKeyForDistrictMock = vi.hoisted(() => vi.fn());
const loadZoningFactForServeMock = vi.hoisted(() => vi.fn());
const loadSetbacksFactForServeMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/zoningFactServeCutover", () => ({
  loadZoningFactForServe: loadZoningFactForServeMock,
}));
vi.mock("../lib/setbacksFactServeCutover", () => ({
  loadSetbacksFactForServe: loadSetbacksFactForServeMock,
}));
vi.mock("../lib/buildableEnvelope/spineZoningDistrict", () => ({
  resolveSpineZoningWhenGisAbsent: resolveSpineZoningWhenGisAbsentMock,
  recordJurisdictionKeyForDistrict: recordJurisdictionKeyForDistrictMock,
  spineZoningProvenanceNote: (resolution: {
    district: string;
    source: string;
    snapshotAt?: string | null;
  }) =>
    resolution.source === "parcel-record"
      ? `Zoning district ${resolution.district} and its setbacks read from the parcel record rails.`
      : `Zoning district ${resolution.district} read from baked node-facet snapshot` +
        ` (GIS parcel.zoningCode absent; not invented).`,
}));

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);
// P-151: dynamic, like the imports above — a static top-level import of the
// route module here would resolve (and trigger the mocked module graph,
// including the "../lib/buildableEnvelope/roads" factory referencing
// BASTROP_LAT below) before BASTROP_LAT's own `const` initializes, a TDZ
// ReferenceError. Every other import that reaches the route module in this
// file is dynamic and placed after the mocks/consts for the same reason.
const { POINT_RESOLUTION_TIMEOUT_MS } = await import(
  "../routes/brokeragePlaceBuildableEnvelope"
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
  pinQueryHang = false;
  lastPinQueryPoint = null;
  situsOutcome = { hit: null, reason: "no-situs-match" };
  rooftopHit = null;
  identityFetchResult = null;
  identityFetchMissing = false;
  identityFetchThrow = null;
  lastIdentityFetch = null;
  geocodeOverride = null;
  geocodeMiss = false;
  parcelSitusAddress = "1209 Main St";
  resolveSpineZoningWhenGisAbsentMock.mockReset();
  resolveSpineZoningWhenGisAbsentMock.mockResolvedValue(null);
  recordJurisdictionKeyForDistrictMock.mockReset();
  recordJurisdictionKeyForDistrictMock.mockResolvedValue(null);
  fetchPropertyAtomChainMock.mockReset();
  fetchPropertyAtomChainMock.mockResolvedValue(null);
  loadZoningFactForServeMock.mockReset();
  loadZoningFactForServeMock.mockResolvedValue({
    state: "present",
    source: "zoning-fact-parcel-record",
    entityId: "48021:34049",
    district: "R-MD",
    jurisdictionKey: "bastrop-tx",
    provenance: null,
    sourceAdapter: "parcel_record",
    sourceVintage: "2026-09-25",
    evaluatedAt: "2026-09-25",
  });
  loadSetbacksFactForServeMock.mockReset();
  loadSetbacksFactForServeMock.mockResolvedValue({
    state: "present",
    source: "setbacks-fact-parcel-record",
    entityId: "48021:34049",
    frontFt: 25,
    sideFt: 10,
    rearFt: 20,
    cornerFt: 15,
    sourceAdapter: "parcel_record",
    sourceVintage: "2026-09-25",
    evaluatedAt: "2026-09-25",
  });
});

function ledgerDistrict(
  district: string,
  jurisdictionKey: string,
  setbacks: { frontFt: number; sideFt: number; rearFt: number; cornerFt: number | null },
) {
  loadZoningFactForServeMock.mockResolvedValue({
    state: "present",
    source: "zoning-fact-parcel-record",
    entityId: "ledger-test",
    district,
    jurisdictionKey,
    provenance: null,
    sourceAdapter: "parcel_record",
    sourceVintage: "2026-09-25",
    evaluatedAt: "2026-09-25",
  });
  loadSetbacksFactForServeMock.mockResolvedValue({
    state: "present",
    source: "setbacks-fact-parcel-record",
    entityId: "ledger-test",
    frontFt: setbacks.frontFt,
    sideFt: setbacks.sideFt,
    rearFt: setbacks.rearFt,
    cornerFt: setbacks.cornerFt,
    sourceAdapter: "parcel_record",
    sourceVintage: "2026-09-25",
    evaluatedAt: "2026-09-25",
  });
}

function ledgerSetbacksRefused(reason: string) {
  loadSetbacksFactForServeMock.mockResolvedValue({
    state: "refused",
    code: "parcel-record-engine-refused",
    source: "setbacks-fact-parcel-record",
    entityId: "ledger-test",
    reason,
  });
}

describe("POST /place/buildable-envelope", () => {
  it("derives geometry from the ledger rails (unified labelEdges+derive)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34049";
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.derivePath).toBe("labelEdges+derive");
    expect(res.body.layer).toBe("buildable-envelope");
    expect(res.body.confidence).toBeDefined();
    expect(res.body.confidence.kind).toBe("asserted");
    expect(res.body.payload.approximate).toBe(false);
    expect(res.body.coverage.degraded).toBe(true);
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.payload.geojson.features.length).toBeGreaterThan(0);
  });

  it("words a not-applicable zoning cell with the cell's own reason", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34049";
    const sentence = "unincorporated parcel: the county does not zone land outside city limits";
    loadZoningFactForServeMock.mockResolvedValue({
      state: "absent",
      source: "zoning-fact-parcel-record",
      entityId: "48021:34049",
      absence: { kind: "not-applicable", reason: sentence },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    });
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe(sentence);
    expect(res.body.declineReason).toBe("not-applicable");
    expect(res.body.declineReason).not.toBe("no-zoning-stamp");
  });

  it("derives SF-1 from the ledger when the GIS stamp is null", async () => {
    parcelZoning = null;
    parcelNodeIdStamped = "48021:33512";
    loadZoningFactForServeMock.mockResolvedValue({
      state: "present",
      source: "zoning-fact-parcel-record",
      entityId: "48021:33512",
      district: "SF-1",
      jurisdictionKey: "bastrop-tx",
      provenance: null,
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-25",
      evaluatedAt: "2026-09-25",
    });
    const res = await post({ address: "714 Spring St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.spineZoningSource).toBe("parcel-record");
    expect(res.body.effectiveZoningCode).toBe("SF-1");
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.payload.geojson.features.length).toBeGreaterThan(0);
    expect(res.body.coverage.reason).toContain("parcel record");
  });

  it("draws the ledger when the situs city names no table", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34049";
    const res = await post({ address: "1 Main St, Nowhere, XX" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.effectiveZoningCode).toBe("R-MD");
  });
});

describe("POST /place/buildable-envelope — parcel_node_id schema + city-less situs (WDLL 1-3)", () => {
  const DASHWOOD_SITUS = "17006 DASHWOOD CREEK DR , TX 78660";
  const DASHWOOD_NODE = "48453:280210";

  it("400 unrecognized_keys when an extra field is present", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    const res = await post({
      address: "1209 Main St, Bastrop, TX 78602",
      extra_field: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    const codes = (res.body.issues as Array<{ code?: string; keys?: string[] }>)
      .map((i) => i.code);
    expect(codes).toContain("unrecognized_keys");
    const keys = (res.body.issues as Array<{ keys?: string[] }>).flatMap(
      (i) => i.keys ?? [],
    );
    expect(keys).toContain("extra_field");
  });

  it("accepts parcel_node_id (no longer unrecognized_keys)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34137";
    const res = await post({
      address: "908 PINE , BASTROP, TX 78602",
      parcel_node_id: "48021:34137",
    });
    expect(res.status).not.toBe(400);
    expect(res.body.error).not.toBe("invalid_body");
    const issues = (res.body.issues ?? []) as Array<{ keys?: string[] }>;
    expect(issues.flatMap((i) => i.keys ?? [])).not.toContain("parcel_node_id");
  });

  it("Dashwood city-less situs serves the ledger cells, not a city-derived table", async () => {
    parcelZoning = "SF-S";
    parcelNodeIdStamped = DASHWOOD_NODE;
    loadZoningFactForServeMock.mockResolvedValue({
      state: "present",
      source: "zoning-fact-parcel-record",
      entityId: DASHWOOD_NODE,
      district: "SF-S",
      jurisdictionKey: "pflugerville-tx",
      provenance: null,
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-25",
      evaluatedAt: "2026-09-25",
    });
    loadSetbacksFactForServeMock.mockResolvedValue({
      state: "present",
      source: "setbacks-fact-parcel-record",
      entityId: DASHWOOD_NODE,
      frontFt: 25,
      sideFt: 7.5,
      rearFt: 20,
      cornerFt: 15,
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-25",
      evaluatedAt: "2026-09-25",
    });
    parcelSitusAddress = DASHWOOD_SITUS;
    // Live Nominatim leaves city empty on this CAD line; do not invent Bastrop.
    geocodeOverride = {
      lat: BASTROP_LAT,
      lng: BASTROP_LNG,
      city: "",
      state: "TX",
      matchRung: "street",
    };
    const res = await post({
      address: DASHWOOD_SITUS,
      parcel_node_id: DASHWOOD_NODE,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.parcel_node_id).toBe(DASHWOOD_NODE);
    expect(res.body.setbacks).toEqual({
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
      district: "SF-S",
    });
  });

  it("Wainee-class no stamp still honest-declines (node does not invent a district)", async () => {
    parcelZoning = null;
    parcelNodeIdStamped = "48021:35772";
    parcelSitusAddress = "195 WAINEE DR, BASTROP, TX 78602";
    loadZoningFactForServeMock.mockResolvedValue({
      state: "absent",
      source: "zoning-fact-parcel-record",
      entityId: "48021:35772",
      absence: {
        kind: "not-applicable",
        reason: "unincorporated parcel: the county does not zone land outside city limits",
      },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    });
    const res = await post({
      address: "195 Wainee Dr, Bastrop, TX 78602",
      parcel_node_id: "48021:35772",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe(
      "unincorporated parcel: the county does not zone land outside city limits",
    );
    expect(res.body.declineReason).not.toBe("no-zoning-stamp");
    expect(res.body.setbacks).toBeUndefined();
  });
});

describe("POST /place/buildable-envelope — parcel_node_id (canvas-free map snap)", () => {
  it("emits the tile-matching parcel_node_id on the decline path (top-level + payload.parcel)", async () => {
    parcelZoning = "R-MD";
    // The Hays 576 Sage Thrasher known case: Hays fips 48209, prop_id 123767
    // -> the parcel provider stamps parcel_node_id "48209:123767", which must
    // byte-match the PMTiles promoteId. The route reads it straight off the
    // resolved feature (no re-derivation).
    parcelNodeIdStamped = "48209:123767";
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    // FE contract: uniform top-level field across all statuses.
    expect(res.body.parcel_node_id).toBe("48209:123767");
    // And inside the parcel identity block on the payload.
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

  it("emits parcel_node_id on derive path so the map still snaps + glows", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48209:123767";
    const res = await post({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.parcel_node_id).toBe("48209:123767");
  });
});

// ---------------------------------------------------------------------------
// P-373 (2026-09-19) — the address/parcel match, fixed at its cause.
//
// Three subjects either matched NO parcel or a STRANGER's parcel, because the
// only route to a parcel was a DERIVED point:
//   - `48055:40428` / `48055:27929` (Caldwell): composed address never
//     matched a parcel; the fall-through geocode's point sat in a neighbour.
//   - `48453:352594` (Travis/Buda): answered from its record point, which
//     pin-queries `48209:10757` — a Hays parcel in ANOTHER county.
//
// The fix is at the cause: a request that NAMES its subject
// (`parcel_node_id`) is resolved BY THAT IDENTITY, from whichever source the
// subject's county serves, and a point that DISAGREES with the identity is
// refused with a named reason instead of answered with the point's parcel.
// ---------------------------------------------------------------------------
describe("POST /place/buildable-envelope — P-373 identity wins over the point", () => {
  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  it("resolves the IDENTIFIED parcel by identity — no address, no point, no pin-query", async () => {
    parcelZoning = "R-MD";
    // A Caldwell parcel: the county whose store rows carry the situs but no
    // polygon, so only the identity fetch can reach it at all.
    const res = await postWith({ parcel_node_id: "48055:40428" });

    // Caldwell has no codified setback table, so the derivation honestly ends
    // in a decline — the IDENTITY is what must survive either way.
    expect([200, 404]).toContain(res.status);
    expect(res.body.parcel_node_id).toBe("48055:40428");
    // The identity fetch asked Caldwell's source for THAT prop id...
    expect(lastIdentityFetch).toEqual({ fips: "48055", propId: "40428" });
    // ...and the point pin-query was never consulted, so no neighbour could
    // be answered in its place.
    expect(lastPinQueryPoint).toBeNull();
  });

  it("refuses (named) when the sent point falls in ANOTHER COUNTY's parcel", async () => {
    // `48453:352594`'s record point sits in Hays: pin-querying it answers
    // `48209:10757`. Answering that for a card that named the Travis parcel
    // is the wrong-parcel defect itself.
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48209:10757";
    const res = await postWith({
      parcel_node_id: "48453:352594",
      lat: 30.1003,
      lng: -97.82734,
    });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-parcel");
    expect(res.body.declineReason).toBe("parcel-identity-mismatch");
    // The identity it was asked about is returned — the surface can SEE that
    // its own point lands elsewhere...
    expect(res.body.parcel_node_id).toBe("48453:352594");
    // ...and the reason names both parcels + the county the point landed in.
    expect(res.body.reason).toContain("48209:10757");
    expect(res.body.reason).toContain("Hays County");
    expect(res.body.reason).toContain("48453:352594");
    // Nothing is served for the stranger's parcel.
    expect(JSON.stringify(res.body)).not.toContain("no-district");
  });

  it("carries on when the sent point AGREES with the identity (point still honored)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48453:352594";
    const res = await postWith({
      parcel_node_id: "48453:352594",
      lat: 30.1003,
      lng: -97.82734,
    });

    expect(res.body.declineReason).not.toBe("parcel-identity-mismatch");
    expect(res.body.parcel_node_id).toBe("48453:352594");
    expect(lastPinQueryPoint).toEqual({
      latitude: 30.1003,
      longitude: -97.82734,
    });
  });

  it("serves a point inside the IDENTIFIED parcel's own ring, even when its pin-query lands in another county (paired control)", async () => {
    // P-339/P-366 residual (2026-09-21) — THE POINT THE IDENTITY ALREADY
    // ANSWERS FOR. `48453:352594` is a Travis parcel whose record point ALSO
    // falls inside a Hays parcel (`48209:10757`), because the two counties'
    // geometries overlap at the county line and the pin-query resolves through
    // the nearest county source rather than the id's. Before this, a card that
    // named its own parcel and its own record point was refused on the evidence
    // of that same record point.
    //
    // The stub models the overlap faithfully: the PIN-QUERY parcel is stamped
    // `48209:10757` while the identified parcel's ring is the one the point is
    // inside. Same request both times — only the point moves — so the pair is a
    // control on the ring check itself, not on any other input.
    parcelSitusAddress = "OLD SAN ANTONIO RD";
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48209:10757";

    const inside = await postWith({
      parcel_node_id: "48453:352594",
      lat: BASTROP_LAT,
      lng: BASTROP_LNG,
    });
    expect(inside.body.declineReason).not.toBe("parcel-identity-mismatch");
    expect(inside.body.parcel_node_id).toBe("48453:352594");
    // The identity's own ring answered the check, so no neighbour lookup ran.
    expect(lastPinQueryPoint).toBeNull();

    const outside = await postWith({
      parcel_node_id: "48453:352594",
      lat: 30.1003,
      lng: -97.82734,
    });
    expect(outside.status).toBe(404);
    expect(outside.body.declineReason).toBe("parcel-identity-mismatch");
    expect(lastPinQueryPoint).toEqual({
      latitude: 30.1003,
      longitude: -97.82734,
    });
  });

  it("declines honestly when the identity's county has no parcel source in this build", async () => {
    const res = await postWith({ parcel_node_id: "48999:1" });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-parcel");
    expect(res.body.declineReason).toBe("parcel-source-absent-in-county");
    expect(res.body.parcel_node_id).toBe("48999:1");
    // No county to ask -> no identity fetch was made.
    expect(lastIdentityFetch).toBeNull();
  });

  it("declines honestly when the identified parcel is absent from its county's source", async () => {
    identityFetchMissing = true;
    const res = await postWith({ parcel_node_id: "48055:40428" });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe("no-parcel");
    expect(res.body.declineReason).toBe("parcel-identity-not-found");
    expect(res.body.reason).toContain("Caldwell County");
    expect(res.body.parcel_node_id).toBe("48055:40428");
  });

  it("400s a parcel_node_id that is not an identity (never treated as a lookup key)", async () => {
    const res = await postWith({ parcel_node_id: "40428" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_parcel_node_id");
    expect(lastIdentityFetch).toBeNull();
  });

  it("a parceled identity with NO address and NO stamp still declines honestly (no district invented)", async () => {
    // Situs-less, stamp-less parcel: the identity is honored (the node id is
    // stated on the wire) and the district is honestly absent.
    identityFetchResult = {
      geojson: rectParcel(null, "48055:40428", ""),
      featureCount: 1,
      queryMode: "identity" as const,
    };
    loadZoningFactForServeMock.mockResolvedValue({
      state: "absent",
      source: "zoning-fact-parcel-record",
      entityId: "48055:40428",
      absence: {
        kind: "absent-verified",
        reason: "no zoning layer yet for this city",
      },
      verifiedAbsence: true,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    });
    const res = await postWith({ parcel_node_id: "48055:40428" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no zoning layer yet for this city");
    expect(res.body.declineReason).toBe("absent-verified");
    expect(res.body.setbacks).toBeUndefined();
    expect(res.body.parcel_node_id).toBe("48055:40428");
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

  it("P-339/P-366 residual: the STAMPED jurisdiction leads the situs/geocode city for the setback table", async () => {
    // `48491:R415488`'s district is SF-S off Pflugerville's own zoning layer —
    // the stamp names `pflugerville-tx` — while its situs/geocoded city is
    // Round Rock. Probing Round Rock's table for a Pflugerville district found
    // no row and refused `no-district`, for a district whose own city codifies
    // it, at the same moment the card served that row (25/7.5/20/15). Here the
    // stubbed geocode city is Bastrop: the same disagreement, measured on the
    // real pair of keys.
    parcelZoning = null;
    parcelNodeIdStamped = "48491:R415488";
    loadZoningFactForServeMock.mockResolvedValue({
      state: "present",
      source: "zoning-fact-parcel-record",
      entityId: "48491:R415488",
      district: "SF-S",
      jurisdictionKey: "pflugerville-tx",
      provenance: null,
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-25",
      evaluatedAt: "2026-09-25",
    });
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.effectiveZoningCode).toBe("SF-S");
    expect(res.body.setbackSource).toBe("parcel-record");
  });

  it("the control: a stamped jurisdiction with NO row for the district still declines no-district (the key is an authority, not a search)", async () => {
    // Without this direction, "the stamp's jurisdiction draws" could pass by the
    // derivation hunting other jurisdictions until some table answered a code —
    // the move P-340 forbids. A key that owns no row refuses, named.
    parcelZoning = null;
    parcelNodeIdStamped = "48491:R415488";
    loadSetbacksFactForServeMock.mockResolvedValue({
      state: "refused",
      code: "parcel-record-engine-refused",
      source: "setbacks-fact-parcel-record",
      entityId: "48491:R415488",
      reason: "no setback row for district CS",
    });
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no setback row for district CS");
    expect(res.body.status).not.toBe("no-district");
  });

  // -------------------------------------------------------------------------
  // P-339/P-366 residual — the SECOND source of the same pair: the record cell.
  //
  // The map's request after P-383 posts the parcel id beside the address, and
  // the identity path answers by identity (P-373) — so on those requests
  // NOTHING but the parcel's own cells can key the table. Travis' and Caldwell's
  // parcel sources stamp a `zoningCode` (measured live 2026-09-21:
  // `payload.parcel.zoningCode: "SF"` on `48453:367134`, `"SF-S"` on
  // `48453:280210`) and a stamp suppresses the spine read entirely, so the
  // record's cell — the only source that names a jurisdiction at all, and the
  // cell the card is served from — was never read by the draw path. Measured on
  // the same day, the identity path answered `no-district` for `48453:239852`
  // (record: SF-3 / austin-tx), `48453:523600` (SU / cedar-park-tx),
  // `48055:40428` (P / san-marcos-tx) and `48055:27929` (R1 / martindale-tx) —
  // four buckets that PASS the customer leg today, each with its corpus row
  // present and its own card drawing.
  // -------------------------------------------------------------------------

  it("identity path: the record's own pair keys the table when no city names that district", async () => {
    // `48453:523600`: the county store stamps `SU` and names no jurisdiction,
    // the CAD situs carries no city, and the county-wide uniqueness scan for
    // `SU` in Travis answers NOTHING (measured in this repo's own corpus:
    // `jurisdictionKeyFromParcelNode({parcelNodeId: "48453:523600",
    // districtCode: "SU"})` -> null), so the district's own city was never
    // probed at all. The record's cell names `cedar-park-tx` BESIDE that
    // district, and that is the key the table probe must run against.
    parcelZoning = "SU";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "1006 WISTERIA CIR";
    ledgerDistrict("SU", "cedar-park-tx", {
      frontFt: 25,
      sideFt: 10,
      rearFt: 20,
      cornerFt: 15,
    });

    const res = await postWith({ parcel_node_id: "48453:523600" });

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.effectiveZoningCode).toBe("SU");
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(recordJurisdictionKeyForDistrictMock).not.toHaveBeenCalled();
  });

  it("CONTROL (the same request with NO record key): `SU` declines exactly as it did — the read is what moved it", async () => {
    // Without this direction, "the record's key resolves it" could pass by the
    // citation of a key nothing read, or by a grader softened under it.
    parcelZoning = "SU";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "1006 WISTERIA CIR";
    ledgerSetbacksRefused("no setback row for district SU");

    const res = await postWith({ parcel_node_id: "48453:523600" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no setback row for district SU");
    expect(recordJurisdictionKeyForDistrictMock).not.toHaveBeenCalled();
  });

  it("identity path: a BASE code takes the record's key, and the row still comes from the signal that names one", async () => {
    // `48453:239852`: the county store's base code `SF` is the value the route
    // reads as that parcel's district code (P-340's own note), and P-340 refuses
    // to cross it into `SF-4A` — so the ROW has to come from the layer that
    // names a district, here the atom chain's `SF-3`. What was missing was the
    // KEY: the uniqueness scan for `SF` answers nothing (measured), so no
    // jurisdiction's table was ever probed for this parcel's signals.
    parcelZoning = "SF";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "1006 WISTERIA CIR";
    ledgerDistrict("SF-3", "austin-tx", {
      frontFt: 25,
      sideFt: 5,
      rearFt: 10,
      cornerFt: 15,
    });

    const res = await postWith({ parcel_node_id: "48453:239852" });

    expect(res.status).toBe(200);
    expect(res.body.effectiveZoningCode).toBe("SF-3");
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.setbacks?.front_ft).toBe(25);
    expect(recordJurisdictionKeyForDistrictMock).not.toHaveBeenCalled();
  });

  it("CONTROL (the same request with NO record key): the base code names no row and declines no-district (P-340 preserved)", async () => {
    // Without this direction the base-code test above could pass by the key
    // resurrecting the exact crossing P-340 refuses: `SF` begins six Austin
    // rows and therefore names none of them, key or no key.
    parcelZoning = "SF";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "1006 WISTERIA CIR";
    ledgerSetbacksRefused("no setback row for district SF");

    const res = await postWith({ parcel_node_id: "48453:239852" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no setback row for district SF");
    expect(recordJurisdictionKeyForDistrictMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // P-406 (OPS-25, 2026-09-22) — THE STAMPED KEY RESOLVES THROUGH THE REGISTRY
  // ENTRY'S OWN `cityKey`.
  //
  // `ZONING_LAYERS` is keyed by ENTRY NAME and an entry's `cityKey` is the
  // jurisdiction it serves. The strings are identical for 23 of the 26 entries
  // and differ for the three that carry one city over several counties
  // (`elgin-tx-travis` -> `elgin-tx`, `austin-tx-williamson` / `austin-tx-hays`
  // -> `austin-tx`). The Travis-side Elgin entry exists to perform exactly that
  // indirection — its own comment says `cityKey` is the literal `elgin-tx` so
  // the stamp persists the string `isElginCityJurisdiction` routes the ratified
  // Elgin table on — and the P-339/P-366 rule shipped the ENTRY NAME as the key
  // instead, walking straight past it. Measured live: `48453:959606` (Elgin,
  // Travis side) refused `no-district` on the canary while PROD drew R-3.
  // -------------------------------------------------------------------------

  it("P-406: the record's key names the registry ENTRY and resolves through its cityKey (48453:959606)", async () => {
    // The record cell carries the ENTRY NAME, exactly as the canary shipped it.
    parcelZoning = "R-3";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "18529 SPOTTED EAGLE LN";
    ledgerDistrict("R-3", "elgin-tx", {
      frontFt: 15,
      sideFt: 7.5,
      rearFt: 10,
      cornerFt: 15,
    });

    const res = await postWith({ parcel_node_id: "48453:959606" });

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.effectiveZoningCode).toBe("R-3");
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.setbacks).toMatchObject({
      front_ft: 15,
      side_ft: 7.5,
      rear_ft: 10,
      side_corner_ft: 15,
    });
    expect(recordJurisdictionKeyForDistrictMock).not.toHaveBeenCalled();
  });

  it("P-406: the same rule reaches the OTHER branch — a spine stamp that names the entry", async () => {
    // The regression is the RULE, not one branch: whichever source held the
    // district and named the entry beside it, the key must resolve the same way.
    parcelZoning = null;
    parcelNodeIdStamped = "48021:34049";
    ledgerDistrict("R-3", "elgin-tx", {
      frontFt: 15,
      sideFt: 7.5,
      rearFt: 10,
      cornerFt: 15,
    });

    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.effectiveZoningCode).toBe("R-3");
    expect(res.body.setbacks?.front_ft).toBe(15);
    expect(resolveSpineZoningWhenGisAbsentMock).not.toHaveBeenCalled();
  });

  it("P-406 CONTROL: a key that names NO entry is echoed BYTE-IDENTICAL — the fix is not a fuzzy match", async () => {
    // The direction that would have caught a fix which "restores Elgin by
    // loosening key resolution generally": `elgin-travis-tx` is one reordered
    // token away from the entry name and must NOT become `elgin-tx`, and the
    // four keys the change exists to protect must come back unaltered in the
    // refusal's own echo. A key that names no entry is a key, and the route
    // reports the one it was given.
    parcelZoning = "QQ-9";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "1006 WISTERIA CIR";
    ledgerSetbacksRefused("no setback row for district QQ-9");
    for (const key of [
      "elgin-travis-tx",
      "lakeway-tx",
      "robinson-tx",
      "luling-tx",
      "smithville-tx",
      "waco_tx",
      "austin_tx",
    ]) {
      recordJurisdictionKeyForDistrictMock.mockResolvedValue(key);
      const res = await postWith({ parcel_node_id: "48453:959606" });
      expect(res.status, key).toBe(200);
      expect(res.body.status, key).toBe("declined");
      expect(res.body.reason, key).toBe("no setback row for district QQ-9");
      expect(res.body.jurisdictionKey, key).not.toBe(key);
    }
  });

  it("P-406 CONTROL: the Elgin key itself, with a district the ratified table has no row for, still declines", async () => {
    // The rule translates the KEY; it never grows the table. `QQ-9` is not an
    // Elgin row, so resolving `elgin-tx-travis` to `elgin-tx` must not make it
    // serveable — otherwise the fix would be a licence to answer anything.
    parcelZoning = "QQ-9";
    parcelNodeIdStamped = null;
    parcelSitusAddress = "18529 SPOTTED EAGLE LN";
    ledgerSetbacksRefused("no setback row for district QQ-9");

    const res = await postWith({ parcel_node_id: "48453:959606" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no setback row for district QQ-9");
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
    // P-373: the situs hit is fetched through the identity seam (one parcel,
    // by its own prop id, from whichever source the county serves) — a Hays
    // store read here.
    identityFetchResult = {
      geojson: rectParcel("R-MD", "48209:193340"),
      featureCount: 1,
      queryMode: "pin" as const,
    };
    ledgerSetbacksRefused("no zoning layer yet for this city");
    const res = await postWith({ address: "300 Blanco River Rd, Wimberley, TX 78676" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.reason).toBe("no zoning layer yet for this city");
    expect(lastIdentityFetch).toEqual({ fips: "48209", propId: "193340" });
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

  it("still derives through the point path (no regression)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34049";
    situsOutcome = { hit: null, reason: "no-situs-match" };
    geocodeOverride = null;
    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(res.body.derivePath).toBe("labelEdges+derive");
  });
});

describe("POST /place/buildable-envelope — P-151 bounded point-resolution timeout", () => {
  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  it(
    "declares a bounded 503 refusal when a bare {lat,lng} pin-query never settles within the time budget",
    async () => {
      parcelZoning = "R-MD";
      parcelNodeIdStamped = null;
      // Simulate the reported failure shape directly: the point-resolution
      // query hangs (e.g. orphaned under DB pool contention) instead of
      // erroring or returning.
      //
      // REAL timers, deliberately: `vi.useFakeTimers()` does not reliably
      // drive `supertest`'s actual HTTP round-trip through an Express app
      // (its socket I/O has its own event-loop scheduling that
      // `vi.advanceTimersByTimeAsync` does not fully virtualize) -- that
      // combination hung this exact test past Vitest's own 20s default
      // test timeout in CI. A real (but bounded, and explicitly extended
      // via this test's own timeout below) wait is the reliable way to
      // exercise a `setTimeout`-based race against a real request/response
      // cycle here.
      pinQueryHang = true;
      // Bare {lat,lng}, no address -- the exact 2026-09-11 repro shape.
      const res = await postWith({ lat: 30.2672, lng: -97.7431 });
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("resolution-timeout");
      expect(res.body.errorClass).toBe("resolution_timeout");
      expect(res.body.parcel_node_id).toBeNull();
      expect(typeof res.body.message).toBe("string");
    },
    POINT_RESOLUTION_TIMEOUT_MS + 10_000,
  );

  it("still resolves normally (no 503, no added latency) for a bare {lat,lng} request that answers promptly", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:34049";
    pinQueryHang = false;
    const res = await postWith({ lat: 30.2672, lng: -97.7431 });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|no-buildable-area/);
    expect(lastPinQueryPoint).toEqual({ latitude: 30.2672, longitude: -97.7431 });
  });

  it("a genuine provider error on the explicit-coordinates branch still 502s (timeout classification does not swallow real errors)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    pinQueryThrow = new AdapterRunError(
      "upstream-error",
      "county ArcGIS service returned HTTP 500",
    );
    const res = await postWith({ lat: 30.2672, lng: -97.7431 });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("parcel-unavailable");
  });
});

describe("POST /place/buildable-envelope — atom-chain provenanceRefs (R3)", () => {
  const RETRIEVAL_KEY = "test-retrieval-key";

  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  // No `outcome` on buildableEnvelope: these tests are scoped to DID-based
  // provenanceRefs attachment (R3), not the atom-outcome reconciliation
  // (reconcileAtomEnvelope.ts) — an incidental "buildable" outcome here
  // would otherwise trigger reconciliation and change derivePath, which
  // neither test asserts on or intends to exercise.
  function baseChainWire(): Record<string, unknown> {
    return {
      zoningFact: { district: "R-MD" },
      setbackRule: { front: 25, side: 5, rear: 10, districtCode: "R-MD" },
      buildableEnvelope: {
        readContract: { axes: { assertedConfidence: { estimate: 0.62 } } },
      },
    };
  }

  beforeEach(() => {
    process.env.HAUSKA_RETRIEVAL_API_KEY = RETRIEVAL_KEY;
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:33512";
  });

  afterEach(() => {
    delete process.env.HAUSKA_RETRIEVAL_API_KEY;
    vi.unstubAllGlobals();
  });

  it("populates provenanceRefs when the atom-chain wire carries DID fields", async () => {
    const wire = baseChainWire();
    (wire.zoningFact as Record<string, unknown>).atomDid = "did:hauska:zoning:1";
    (wire.setbackRule as Record<string, unknown>).atomDid = "did:hauska:setback:1";
    (wire.buildableEnvelope as Record<string, unknown>).atomDid =
      "did:hauska:envelope:1";
    wire.codeSections = [
      { atomDid: "did:hauska:code-section:1", sectionNumber: "5.4.2", title: "Setbacks" },
      // Malformed entry (no atomDid) must be dropped, not passed through.
      { sectionNumber: "9.9.9" },
    ];

    fetchPropertyAtomChainMock.mockResolvedValue(wire);

    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });

    expect(res.status).toBe(200);
    expect(res.body.derivePath).toBe("labelEdges+derive");
    expect(res.body.provenanceRefs).toEqual({
      zoning: { atomDid: "did:hauska:zoning:1" },
      setback: { atomDid: "did:hauska:setback:1" },
      envelope: { atomDid: "did:hauska:envelope:1" },
      codeSections: [
        { atomDid: "did:hauska:code-section:1", sectionNumber: "5.4.2", title: "Setbacks" },
      ],
    });
  });

  it("omits provenanceRefs entirely when the wire carries no DID fields (today's baseline)", async () => {
    const wire = baseChainWire();
    fetchPropertyAtomChainMock.mockResolvedValue(wire);

    const res = await postWith({ address: "1209 Main St, Bastrop, TX 78602" });

    expect(res.status).toBe(200);
    expect(res.body.derivePath).toBe("labelEdges+derive");
    // Nothing to attach yet — omitted, not emitted as null/empty.
    expect(res.body.provenanceRefs).toBeUndefined();
    expect(res.body.status).toBe("ok");
    expect(res.body.setbackSource).toBe("parcel-record");
    expect(res.body.setbacks).toEqual({
      front_ft: 25,
      side_ft: 10,
      rear_ft: 20,
      side_corner_ft: 15,
      district: "R-MD",
    });
    expect(res.body.payload.geojson.features.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P-304 (2026-09-17) — "area figure no longer reaches anonymous callers".
//
// This route is on the anonymous browse allowlist (hauska-map
// `apps/property-explorer/api/spine.ts`), so whatever lands in
// `payload.geojson.features[].properties` reaches an anonymous reader. A-180
// entitles only a ground-truth VERIFIED (depth-warm promoted) envelope atom to
// a buildable-area figure: the polygon keeps drawing, the two area properties
// are withheld as ABSENCE — never as 0, never as the unverified number.
//
// The dispatch's own pair, asserted at the WIRE (the served JSON), not just at
// the composition:
//   (a) an UNVERIFIED parcel serves no area figure;
//   (b) a verified-atom fixture serves the figure it is entitled to.
// ---------------------------------------------------------------------------
describe("POST /place/buildable-envelope — P-304 area figure withholding", () => {
  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  // The same parcel fixture the R3 block above uses (Bastrop R-MD, GIS-stamped
  // parcel_node_id): the one configuration in which the atom chain is fetched
  // at all, so the entitlement decision is actually exercised rather than
  // vacuously satisfied by a missing chain.
  beforeEach(() => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48021:33512";
  });

  const ADDRESS = "1209 Main St, Bastrop, TX 78602";

  it("(a) anonymous POST to an UNVERIFIED parcel: no area figure, geometry still drawn, disclosure says why", async () => {
    fetchPropertyAtomChainMock.mockResolvedValue({
      zoningFact: { district: "R-MD" },
      setbackRule: { front: 25, side: 5, rear: 10, districtCode: "R-MD" },
      buildableEnvelope: {
        // A number the atom asserts, but NO promotion marker and NO
        // depth-warm citation -> unverified (isEnvelopeAtomVerified).
        outcome: { kind: "buildable", areaSqFt: 7_777 },
        readContract: { axes: { assertedConfidence: { estimate: 0.62 } } },
      },
    });

    const res = await postWith({ address: ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    const p = res.body.payload.geojson.features[0].properties as Record<string, unknown>;

    // THE FINDING, restated at the wire: neither figure reaches the caller...
    expect("buildableAreaSqFt" in p).toBe(false);
    expect("buildableAreaPct" in p).toBe(false);
    // ...not as a zero, and not as the atom's own unverified number.
    expect(p.buildableAreaSqFt).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("7777");

    // The polygon is untouched — withholding a figure is not withholding the
    // draw (the dispatch's "polygon may still draw, figure must not").
    expect(res.body.payload.geojson.features[0].geometry).not.toBeNull();
    expect(res.body.payload.approximate).toBe(false);

    // A reader is told WHY the figure is missing, not left to guess.
    expect(String(p.disclosure)).toContain("withheld");

    // The LOT area is a measured (county appraisal) figure, not the modelled
    // one, and is not withdrawn with it.
    expect(typeof p.parcelAreaSqFt).toBe("number");
  });

  it("(b) verified-atom fixture: the entitled figure IS served (the change withholds only from the unentitled)", async () => {
    fetchPropertyAtomChainMock.mockResolvedValue({
      zoningFact: { district: "R-MD" },
      setbackRule: { front: 25, side: 5, rear: 10, districtCode: "R-MD" },
      buildableEnvelope: {
        depthWarmPromotion: DEPTH_WARM_PROMOTION_MARKER,
        outcome: { kind: "buildable", areaSqFt: 7_777 },
        readContract: { axes: { assertedConfidence: { estimate: 0.9 } } },
      },
    });

    const res = await postWith({ address: ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body.derivePath).toBe("labelEdges+derive+atom-reconciled");
    const p = res.body.payload.geojson.features[0].properties as Record<string, unknown>;
    expect(p.buildableAreaSqFt).toBe(7_777);
    expect(p.buildableAreaPct as number).toBeGreaterThan(0);
    expect(String(p.disclosure ?? "")).not.toContain("withheld");
  });
});

/**
 * P-374 — THE DIVERGENCE TEST.
 *
 * The mission is not "the draw block agrees with the route in the cases we
 * thought of"; it is "there is one derivation, and a test fails when the two
 * callers get different answers". This block runs BOTH callers against the
 * SAME parcel fixture in the SAME process:
 *
 *   - the route, through its real HTTP handler (`brokeragePlaceBuildableEnvelopeRouter`);
 *   - the draw block, through `tryComposeEnvelopeModelForDraw`.
 *
 * and asserts their answers are the SAME answer — the same resolved district,
 * the same four axes, the same polygon, and (where neither draws) the same
 * named reason. Neither caller is hand-seeded with a jurisdiction key: the
 * route's city comes from the request geocode, the draw block's from the same
 * ring's own situs string (the fallback that stands in for the card's composed
 * city here), and the two must still reach the one table. That is what pins the
 * jurisdiction-key equivalence the old copy got wrong.
 */
describe("POST /place/buildable-envelope — P-374: the draw block and the route are ONE derivation", () => {
  const ADDRESS = "1209 Main St, Bastrop, TX 78602";
  const NODE = "48021:33512";

  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  async function drawBlock(args: {
    jurisdictionCity?: string | null;
    jurisdictionState?: string | null;
  }) {
    const { tryComposeEnvelopeModelForDraw } = await import(
      "../lib/buildableEnvelope/parcelDrawEnvelopeModel"
    );
    return tryComposeEnvelopeModelForDraw({
      parcelNodeId: NODE,
      jurisdictionCity: args.jurisdictionCity ?? null,
      jurisdictionState: args.jurisdictionState ?? null,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
  }

  it("parity: the same parcel draws the SAME district, the SAME axes and the SAME polygon on both paths", async () => {
    // The ring's OWN situs names the city (the route gets the same city from
    // the request geocode). No key is hand-seeded on either side.
    parcelSitusAddress = ADDRESS;
    parcelZoning = "R-MD";
    parcelNodeIdStamped = NODE;

    const res = await postWith({ address: ADDRESS });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.effectiveZoningCode).toBeTruthy();

    const mcp = await drawBlock({});
    expect(mcp.state).toBe("modelled");
    if (mcp.state !== "modelled") throw new Error("unreachable");

    // The resolved district the route SERVES, not the raw code that seeded the
    // probe: pre-P-374 the draw block named its own input here.
    expect(mcp.model.setbacks.district).toBe(res.body.effectiveZoningCode);
    const routeSetbacks = res.body.setbacks as Record<string, number>;
    expect(mcp.model.setbacks).toEqual({
      front_ft: routeSetbacks.front_ft,
      side_ft: routeSetbacks.side_ft,
      rear_ft: routeSetbacks.rear_ft,
      ...(typeof routeSetbacks.side_corner_ft === "number"
        ? { side_corner_ft: routeSetbacks.side_corner_ft }
        : {}),
      district: res.body.effectiveZoningCode,
    });
    // ...and the same polygon: the two surfaces are looking at one draw.
    const routeRing = (
      res.body.payload.geojson.features[0] as {
        geometry: { coordinates: [number, number][][] };
      }
    ).geometry.coordinates[0];
    expect(mcp.model.ringLngLat).toEqual(routeRing);
  });

  it("parity where the ring carries no stamp: both paths read the spine, and both draw (the FALSIFIER for the old draw block)", async () => {
    // Pre-P-374 this case was the divergence: the route read the spine and
    // drew; the draw block refused `no-zoning-code` on its caller's missing
    // facet alone, and the overlay then said the setbacks were unruled beside
    // a ruled table. Same mock, same parcel, one derivation — so both draw.
    parcelSitusAddress = ADDRESS;
    parcelZoning = null;
    parcelNodeIdStamped = NODE;
    resolveSpineZoningWhenGisAbsentMock.mockResolvedValue({
      district: "R-MD",
      source: "baked-snapshot",
      snapshotAt: "2026-07-20T12:00:00.000Z",
    });

    const res = await postWith({ address: ADDRESS });
    expect(res.body.effectiveZoningCode).toBe("R-MD");

    const mcp = await drawBlock({});
    expect(mcp.state).toBe("modelled");
    if (mcp.state !== "modelled") throw new Error("unreachable");
    expect(mcp.model.setbacks.district).toBe(res.body.effectiveZoningCode);
  });

  it("THE PARITY CHECK CAN FAIL: seed the draw block with a jurisdiction the route never used and the answers differ", async () => {
    // The control for the two tests above. If the two callers could not
    // disagree, "they agree" would prove nothing — so here is a case where they
    // must not, and the assertion the parity tests make (equality) is the one
    // that breaks.
    parcelSitusAddress = ADDRESS;
    parcelZoning = "R-MD";
    parcelNodeIdStamped = NODE;

    const res = await postWith({ address: ADDRESS });
    expect(res.body.status).toBe("ok");

    const mcp = await drawBlock({
      jurisdictionCity: "Nowhere",
      jurisdictionState: "XX",
    });

    // The caller's city is no longer an input. Both surfaces read the ledger,
    // so a city the parcel is not in does not split them.
    const routeDrew = res.body.payload.geojson.features.length > 0;
    const drawBlockDrew = mcp.state === "modelled";
    expect(routeDrew).toBe(true);
    expect(drawBlockDrew).toBe(true);
    expect(drawBlockDrew === routeDrew).toBe(true);
  });
});

/**
 * P-382 (2026-09-19) — AN UNKNOWN IS NOT A "NO".
 *
 * P-373 gave this route two lookups that answered a QUESTION with a two-valued
 * yes/no when the honest answer was three-valued:
 *
 *   (a) `parcelNodeIdAtPoint` — "which parcel is at this point?" A parcels-layer
 *       ERROR was caught and returned as `null`, which `resolvePostedParcelIdentity`
 *       read as "no parcel there" == agreement with the posted identity. The
 *       identity-mismatch refusal was SKIPPED and the request served with
 *       `pointConfidence: "coordinates"` for a point nothing ever checked.
 *   (b) the place point on a widened situs hit — "what point did this address
 *       resolve to before P-373?" P-373's wider candidate set reaches addresses
 *       in live-ArcGIS counties that used to fall through to `resolveContext`,
 *       where the geocode is UPGRADED to the county's authoritative rooftop.
 *       Serving the un-upgraded geocode is the seat's 2026-09-19 canary (five
 *       `placeKey`s that moved off their parcels; 48055:130676 by 5,061 m).
 *
 * Both directions are asserted here: the falsifier (the failure shape) and the
 * control (the same shape where the upstream DID answer, which must not move).
 */
describe("POST /place/buildable-envelope — P-382 an unknown is not a 'no'", () => {
  function postWith(body: Record<string, unknown>) {
    return request(getApp())
      .post("/api/brokerage/v1/place/buildable-envelope")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send(body);
  }

  it("REFUSES (named) when the posted point cannot be checked at all — never serves it unchecked", async () => {
    parcelZoning = "R-MD";
    // A real jurisdiction WITH a setback table (Bastrop) and a matching
    // district (R-MD), so on the pre-change source this request has nothing
    // stopping it: the unmade check is silently skipped and the envelope is
    // SERVED (200) for a point nothing verified. (FALSIFIER.)
    parcelSitusAddress = "1209 Main St, Bastrop, TX 78602";
    // The caller names its parcel AND sends a point. Checking that point means
    // asking the parcels layer; here the layer is DOWN. P-373 swallowed that
    // into `null`, which read as "the point is in no parcel" — i.e. agreement
    // with the identity — and the request was served for a point nothing
    // verified.
    pinQueryThrow = new AdapterRunError(
      "upstream-error",
      "county ArcGIS service returned HTTP 500",
    );
    const res = await postWith({
      parcel_node_id: "48021:14899",
      lat: 30.1105,
      lng: -97.3252,
    });

    expect(res.status).toBe(502);
    expect(res.body.status).toBe("parcel-unavailable");
    expect(res.body.declineReason).toBe("point-verification-unavailable");
    // The failure is NAMED, so the surface can see WHY it could not check.
    expect(res.body.reason).toContain("upstream-error");
    // ...and the identity the caller named is echoed back, not a stranger's.
    expect(res.body.parcel_node_id).toBe("48021:14899");
    // Nothing is served: no envelope, no district, no setbacks.
    expect(res.body.setbacks).toBeUndefined();
  });

  it("CONTROL: the upstream's DECLARED empty coverage is an answer — the check carries on", async () => {
    parcelZoning = "R-MD";
    parcelSitusAddress = "1209 Main St, Bastrop, TX 78602";
    // Same request, but the layer ANSWERED: this point is in no parcel the
    // provider covers (`no-coverage` is the route's established "no parcel
    // here", not an outage). An unknown must not be a "no" — and a "no" must
    // not be read as an unknown, or every honest gap would start 502ing.
    pinQueryThrow = new AdapterRunError(
      "no-coverage",
      "point is outside the provider's coverage",
    );
    const res = await postWith({
      parcel_node_id: "48021:14899",
      lat: 30.1105,
      lng: -97.3252,
    });

    expect(res.status).toBe(200);
    expect(res.body.declineReason).not.toBe("point-verification-unavailable");
    expect(res.body.parcel_node_id).toBe("48021:14899");
  });

  it("CONTROL: a clean identity request is unchanged (the point still agrees, and is honored)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = "48453:352594";
    const res = await postWith({
      parcel_node_id: "48453:352594",
      lat: 30.1003,
      lng: -97.82734,
    });

    expect(res.body.declineReason).not.toBe("point-verification-unavailable");
    expect(res.body.parcel_node_id).toBe("48453:352594");
    expect(lastPinQueryPoint).toEqual({
      latitude: 30.1003,
      longitude: -97.82734,
    });
  });

  // ── The place point on a widened situs hit (the canary) ──────────────────
  //
  // 619 LADERA DR, LULING is a Caldwell (48055) address. Caldwell serves its
  // polygons LIVE while its `txgio_parcel` rows carry no polygon, which is
  // exactly why P-373 widened the situs candidate set to include it: the
  // store's own statewide situs index holds the address, so the address now
  // resolves to ITS parcel instead of a Hays no-coverage. But the geocode is
  // only a ZIP centroid (Luling, 78648), and the pre-P-373 fall-through path
  // upgraded it to Caldwell's own `txgio_address` rooftop before deriving.
  // Serving the centroid is the canary's 5,061 m `placeKey` regression.
  const LULING_ADDRESS = "619 LADERA DR, LULING, TX 78648";
  const LULING_ZIP_CENTROID = { lat: 29.6829, lng: -97.6497 };
  const LULING_ROOFTOP = { lat: 29.68018, lng: -97.66031 };

  it("serves the owning county's ROOFTOP on a widened situs hit — not the coarse geocode (FALSIFIER)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    // This suite does not globally clear mock call history (it resets only the
    // per-test controls), so scope the call assertions to THIS test.
    vi.mocked(resolveRooftopByAddress).mockClear();
    geocodeOverride = {
      lat: LULING_ZIP_CENTROID.lat,
      lng: LULING_ZIP_CENTROID.lng,
      city: "Luling",
      state: "TX",
      matchRung: "zip", // a locality/ZIP centroid, NOT a street hit
    };
    // P-373's widened candidate set now consults Caldwell, whose store situs
    // index answers with the subject's own node id.
    situsOutcome = {
      hit: {
        parcelNodeId: "48055:130676",
        rawPropId: "130676",
        matchSource: "situs",
      },
      resolvedBy: "unique-situs",
    };
    identityFetchResult = {
      geojson: rectParcel("R-MD", "48055:130676"),
      featureCount: 1,
      queryMode: "pin" as const,
    };
    // Caldwell's OWN address index holds the rooftop.
    rooftopHit = {
      latitude: LULING_ROOFTOP.lat,
      longitude: LULING_ROOFTOP.lng,
      matchSource: "txgio-address",
    };

    const res = await postWith({ address: LULING_ADDRESS });

    // The place point is the rooftop the address had before P-373...
    expect(res.body.placeKey).toBe(
      placeKeyFromCoords(
        roundPlaceCoord(LULING_ROOFTOP.lat),
        roundPlaceCoord(LULING_ROOFTOP.lng),
      ),
    );
    // ...and NOT the ZIP centroid the canary served (this is the regression:
    // the geocode centroid was served as the place point).
    expect(res.body.placeKey).not.toBe(
      placeKeyFromCoords(
        roundPlaceCoord(LULING_ZIP_CENTROID.lat),
        roundPlaceCoord(LULING_ZIP_CENTROID.lng),
      ),
    );
    // It was Caldwell's own index that was asked (county-scoped, so a live
    // county's address index is reachable even though its polygons are not
    // in the store).
    expect(vi.mocked(resolveRooftopByAddress)).toHaveBeenCalledWith(
      expect.objectContaining({ countyFips: "48055" }),
    );
  });

  it("CONTROL: a situs hit in a STORE-tagged county is untouched (nothing else moves)", async () => {
    parcelZoning = "R-MD";
    parcelNodeIdStamped = null;
    vi.mocked(resolveRooftopByAddress).mockClear();
    // Hays is store-backed: the situs pre-pass reached it BEFORE P-373 too,
    // so this branch's point is the pre-P-373 point and must not start asking
    // an address index it never asked. (Both directions: the widening is
    // undone for the counties it did not need to widen.)
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
    identityFetchResult = {
      geojson: rectParcel("R-MD", "48209:193340"),
      featureCount: 1,
      queryMode: "pin" as const,
    };
    rooftopHit = {
      latitude: 29.9974,
      longitude: -98.0984,
      matchSource: "txgio-address",
    };

    const res = await postWith({
      address: "300 Blanco River Rd, Wimberley, TX 78676",
    });

    expect(vi.mocked(resolveRooftopByAddress)).not.toHaveBeenCalled();
    expect(res.body.placeKey).toBe(
      placeKeyFromCoords(roundPlaceCoord(29.99741), roundPlaceCoord(-98.09836)),
    );
  });
});
