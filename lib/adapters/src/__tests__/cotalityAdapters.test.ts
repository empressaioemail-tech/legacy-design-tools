/**
 * Cotality national parcel + zoning adapter pair — OAuth2 rework (2026-06-06).
 *
 * Cotality (CoreLogic / Apigee) uses OAuth2 client_credentials per demo app:
 *   COTALITY_PROPERTY_KEY/SECRET     → Property API (attrs + zoning)
 *   COTALITY_SPATIALTILE_KEY/SECRET  → Spatial Tile (parcel polygon)
 *
 * When required creds are absent the adapters surface no-coverage with zero
 * network calls so Regrid remains the fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cotalityParcelsAdapter,
  cotalityZoningAdapter,
  __resetCotalityDedupForTests,
  __resetCotalityTokenCacheForTests,
  cotalityTokenUrl,
  cotalityPropertyBaseUrl,
  cotalitySpatialTileBaseUrl,
  mergeCotalityPropertyAndSpatial,
} from "../national/cotality";
import { runAdapters } from "../runner";
import { FEDERAL_ADAPTERS, ALL_ADAPTERS } from "../registry";
import type { AdapterContext } from "../types";

const ROUND_ROCK: AdapterContext = {
  parcel: {
    latitude: 30.5083,
    longitude: -97.6789,
    address: "1904 Heathwood Cir, Round Rock, TX 78664",
  },
  jurisdiction: { stateKey: "texas", localKey: null },
};

const TEST_CREDS = {
  COTALITY_PROPERTY_KEY: "prop-consumer-key",
  COTALITY_PROPERTY_SECRET: "prop-consumer-secret",
  COTALITY_SPATIALTILE_KEY: "tile-consumer-key",
  COTALITY_SPATIALTILE_SECRET: "tile-consumer-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oauthTokenResponse(token: string): Response {
  return jsonResponse({ access_token: token, expires_in: 3600, token_type: "Bearer" });
}

const SPATIAL_GEOMETRY = {
  type: "Polygon",
  coordinates: [
    [
      [-97.6791, 30.5081],
      [-97.6787, 30.5081],
      [-97.6787, 30.5085],
      [-97.6791, 30.5085],
      [-97.6791, 30.5081],
    ],
  ],
};

function propertyResponseFixture(opts: {
  withZoning?: boolean;
  clip?: string | number;
  county?: string;
} = {}): Record<string, unknown> {
  const { withZoning = true, clip = 9876543210, county = "Williamson" } = opts;
  const out: Record<string, unknown> = {
    clip,
    county,
    vintage: "2026-03-15",
    parcel: {
      attributes: {
        apn: "R-16-1234-5678-90",
        owner: "Test Owner LLC",
        county,
        ...(withZoning
          ? {
              zoning: "R-1",
              zoning_description: "Single-Family Residential",
            }
          : {}),
      },
    },
  };
  if (withZoning) {
    out.zoning = {
      code: "R-1",
      description: "Single-Family Residential",
      zoningType: "residential",
    };
  }
  return out;
}

function spatialResponseFixture(): Record<string, unknown> {
  return { geometry: SPATIAL_GEOMETRY };
}

/** Route fetchImpl by URL/method — token POST + property GET + spatial GET. */
function cotalityFetchRouter(opts: {
  propertyBody?: unknown;
  spatialBody?: unknown;
  propertyStatus?: number;
  spatialStatus?: number;
  tokenStatus?: number;
} = {}) {
  const {
    propertyBody = propertyResponseFixture(),
    spatialBody = spatialResponseFixture(),
    propertyStatus = 200,
    spatialStatus = 200,
    tokenStatus = 200,
  } = opts;

  let propertyTokenFetches = 0;
  let spatialTokenFetches = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth/token") || url === cotalityTokenUrl()) {
      if (method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = init?.body?.toString() ?? "";
      if (body.includes("prop-consumer-key")) {
        propertyTokenFetches += 1;
        if (tokenStatus !== 200) {
          return new Response("token denied", { status: tokenStatus });
        }
        return oauthTokenResponse("property-bearer-token");
      }
      if (body.includes("tile-consumer-key")) {
        spatialTokenFetches += 1;
        if (tokenStatus !== 200) {
          return new Response("token denied", { status: tokenStatus });
        }
        return oauthTokenResponse("spatial-bearer-token");
      }
      return new Response("unknown client", { status: 401 });
    }

    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;

    if (url.includes(cotalityPropertyBaseUrl()) || url.includes("/property/")) {
      expect(auth).toBe("Bearer property-bearer-token");
      if (propertyStatus !== 200) {
        return new Response("upstream error", { status: propertyStatus });
      }
      return jsonResponse(propertyBody);
    }

    if (
      url.includes(cotalitySpatialTileBaseUrl()) ||
      url.includes("/spatialtile/")
    ) {
      expect(auth).toBe("Bearer spatial-bearer-token");
      if (spatialStatus !== 200) {
        return new Response("upstream error", { status: spatialStatus });
      }
      return jsonResponse(spatialBody);
    }

    return new Response("unexpected url", { status: 404 });
  });

  return { fetchImpl, getTokenFetchCounts: () => ({ propertyTokenFetches, spatialTokenFetches }) };
}

function setAllCotalityCreds(): void {
  process.env.COTALITY_PROPERTY_KEY = TEST_CREDS.COTALITY_PROPERTY_KEY;
  process.env.COTALITY_PROPERTY_SECRET = TEST_CREDS.COTALITY_PROPERTY_SECRET;
  process.env.COTALITY_SPATIALTILE_KEY = TEST_CREDS.COTALITY_SPATIALTILE_KEY;
  process.env.COTALITY_SPATIALTILE_SECRET = TEST_CREDS.COTALITY_SPATIALTILE_SECRET;
}

function clearAllCotalityCreds(): void {
  for (const k of Object.keys(TEST_CREDS)) {
    delete process.env[k];
  }
  delete process.env.COTALITY_API_KEY;
}

describe("Cotality adapters — OAuth2 client_credentials (2026-06-06 rework)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [...Object.keys(TEST_CREDS), "COTALITY_API_KEY"]) {
      savedEnv[k] = process.env[k];
    }
    __resetCotalityDedupForTests();
    __resetCotalityTokenCacheForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetCotalityDedupForTests();
    __resetCotalityTokenCacheForTests();
  });

  it("[1] happy path — bearer on API calls; property + spatial merged; point dedup across adapters", async () => {
    setAllCotalityCreds();
    const { fetchImpl } = cotalityFetchRouter();

    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("ok");

    const parcelPayload = byKey["cotality:parcels"]?.result?.payload as {
      kind: string;
      parcel: { type: string; geometry: { type: string }; properties: { clip: number } };
    };
    expect(parcelPayload?.kind).toBe("parcel");
    expect(parcelPayload?.parcel?.geometry?.type).toBe("Polygon");
    expect(parcelPayload?.parcel?.properties?.clip).toBe(9876543210);

    // 2 token POSTs (property + spatialtile) + 1 property GET + 1 spatial GET
    // parcel+zoning share property fetch via dedup (separate dedup keys per mode,
    // but zoning-only skips spatial — so: 2 tokens + 1 property + 1 spatial for parcel,
    // + 0 extra token (cached) + 1 property for zoning)
    const tokenPosts = fetchImpl.mock.calls.filter(
      (c) => String(c[0]).includes("/oauth/token") || (c[1] as RequestInit)?.method === "POST",
    );
    expect(tokenPosts.length).toBe(2);

    const propertyGets = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("property"),
    );
    const spatialGets = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("spatialtile"),
    );
    expect(propertyGets.length).toBe(2); // parcel mode + zoning mode (separate dedup keys)
    expect(spatialGets.length).toBe(1); // parcel mode only
  });

  it("[2] OAuth token cached — second parcel run reuses bearer without re-POSTing token", async () => {
    setAllCotalityCreds();
    const { fetchImpl, getTokenFetchCounts } = cotalityFetchRouter();

    await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const afterFirst = getTokenFetchCounts();
    expect(afterFirst.propertyTokenFetches).toBe(1);
    expect(afterFirst.spatialTokenFetches).toBe(1);

    __resetCotalityDedupForTests(); // new point fetch, but token cache warm

    await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const afterSecond = getTokenFetchCounts();
    expect(afterSecond.propertyTokenFetches).toBe(1);
    expect(afterSecond.spatialTokenFetches).toBe(1);
  });

  it("[3] zoning absent — parcel ok, zoning no-coverage", async () => {
    setAllCotalityCreds();
    const { fetchImpl } = cotalityFetchRouter({
      propertyBody: propertyResponseFixture({ withZoning: false }),
    });
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("ok");
    expect(byKey["cotality:zoning"]?.status).toBe("no-coverage");
  });

  it("[4] missing PROPERTY creds — both adapters no-coverage, zero network", async () => {
    clearAllCotalityCreds();
    process.env.COTALITY_SPATIALTILE_KEY = TEST_CREDS.COTALITY_SPATIALTILE_KEY;
    process.env.COTALITY_SPATIALTILE_SECRET = TEST_CREDS.COTALITY_SPATIALTILE_SECRET;

    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("no-coverage");
    expect(byKey["cotality:parcels"]?.error?.message).toMatch(
      /COTALITY_PROPERTY_KEY\/SECRET/i,
    );
    expect(byKey["cotality:zoning"]?.status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[5] missing SPATIALTILE creds — parcels no-coverage, zoning ok with property only", async () => {
    clearAllCotalityCreds();
    process.env.COTALITY_PROPERTY_KEY = TEST_CREDS.COTALITY_PROPERTY_KEY;
    process.env.COTALITY_PROPERTY_SECRET = TEST_CREDS.COTALITY_PROPERTY_SECRET;

    const { fetchImpl } = cotalityFetchRouter();
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
    expect(byKey["cotality:parcels"]?.status).toBe("no-coverage");
    expect(byKey["cotality:parcels"]?.error?.message).toMatch(
      /COTALITY_SPATIALTILE_KEY\/SECRET/i,
    );
    expect(byKey["cotality:zoning"]?.status).toBe("ok");
  });

  it("[6] HTTP 5xx on property API — upstream-error", async () => {
    setAllCotalityCreds();
    const { fetchImpl } = cotalityFetchRouter({ propertyStatus: 503 });
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toContain("HTTP 503");
  });

  it("[7] malformed JSON on property API — parse-error", async () => {
    setAllCotalityCreds();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token") || (init?.method ?? "GET") === "POST") {
        return oauthTokenResponse("property-bearer-token");
      }
      if (url.includes("property")) {
        return new Response("<not-json>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse(spatialResponseFixture());
    });
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("parse-error");
  });

  it("[8] point dedup — second parcel+zoning run within TTL skips repeat property/spatial GETs for same mode", async () => {
    setAllCotalityCreds();
    const { fetchImpl } = cotalityFetchRouter();

    await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    const callsAfterFirst = fetchImpl.mock.calls.length;

    await runAdapters({
      adapters: [cotalityParcelsAdapter, cotalityZoningAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it("[9] registry shape — cotality adapters in FEDERAL and ALL", () => {
    const keys = ALL_ADAPTERS.map((a) => a.adapterKey);
    expect(keys).toContain("cotality:parcels");
    expect(keys).toContain("cotality:zoning");
    const fed = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(fed).toContain("cotality:parcels");
    expect(fed).toContain("cotality:zoning");
  });

  it("[10] 401 on token endpoint — upstream-error", async () => {
    setAllCotalityCreds();
    const { fetchImpl } = cotalityFetchRouter({ tokenStatus: 401 });
    const outcomes = await runAdapters({
      adapters: [cotalityParcelsAdapter],
      context: { ...ROUND_ROCK, fetchImpl },
    });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error?.code).toBe("upstream-error");
    expect(outcomes[0]?.error?.message).toMatch(/401|OAuth token/i);
  });

  it("mergeCotalityPropertyAndSpatial attaches spatial geometry to parcel", () => {
    const merged = mergeCotalityPropertyAndSpatial(
      propertyResponseFixture(),
      spatialResponseFixture(),
    );
    expect(merged.parcel?.geometry).toEqual(SPATIAL_GEOMETRY);
    expect(merged.clip).toBe(9876543210);
  });
});
