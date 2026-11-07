/**
 * Browser-proxy end-user identity — the signed-in tier matrix, real
 * entitlement tables (per-file test schema).
 *
 * The hauska-map proxy presents its own key (BROWSER_PROXY_API_KEYS) plus,
 * for a signed-in visitor, that visitor's own cortex session in
 * X-Hauska-End-User-Session. Cortex must apply THAT user's entitlement:
 * Solo gets Solo (no owner co-gated fields), Studio gets Studio (owner
 * present), anonymous gets the public tier — and the proxy key never makes
 * any of them a service / Max caller. A proxied signed-in user is also
 * metered as themselves by the per-user daily API limit.
 *
 * The no-DB cases (anonymous, forged context, service callers unchanged,
 * mutation falsifier) live in browserProxyEndUser.test.ts. Synthetic only.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const SERVICE_TOKEN = "test-service-token-browser-proxy-tiers";
const PROXY_KEY = "test-browser-proxy-key-tiers";
const BROKERAGE_KEY = "brokerage-test-key-browser-proxy-tiers";
const SYNTH = "SYNTHETIC-GATED-VALUE";
const PARCEL_A = "48999:2001";
const PARCEL_B = "48999:2002";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("browserProxyEndUserTiers.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

function synthParcel(nodeId: string) {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    properties: {
      provider: "txgio",
      countyFips: "48999",
      apn: nodeId.split(":")[1],
      parcel_node_id: nodeId,
      situsAddress: "1 SYNTHETIC WAY",
      owner: SYNTH,
      ownerMailingAddress: SYNTH,
      landUseCode: "A1",
    },
  };
}

vi.mock("../lib/brokerageGisLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisLayers")
  >("../lib/brokerageGisLayers");
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(async (input: { layer: string }) => ({
      layer: input.layer,
      provider: "synthetic",
      adapterKey: `synthetic:${input.layer}`,
      serviceUrl: "https://synthetic.invalid",
      featureCount: 2,
      queryMode: "bbox",
      geojson: {
        type: "FeatureCollection",
        features: [synthParcel(PARCEL_A), synthParcel(PARCEL_B)],
      },
    })),
  };
});

vi.mock("../lib/jurisdictionBoundariesNearBbox", () => ({
  assembleJurisdictionBoundariesNearBbox: vi.fn(async () => ({
    status: "ok",
    provider: "synthetic",
    cityLimits: { type: "FeatureCollection", features: [] },
    etj: { type: "FeatureCollection", features: [] },
    legendNote: "synthetic",
  })),
}));

const dbMod = await import("@workspace/db");
const { users, peUserEntitlements } = dbMod;
const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);
const { __resetBrowserProxyKeysForTests, END_USER_SESSION_HEADER } =
  await import("../middlewares/browserProxyEndUser");
const { mintSessionToken } = await import("../lib/sessionToken");
const { DEFAULT_TENANT_ID } = await import("../middlewares/session");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_API_KEYS = BROKERAGE_KEY;
  process.env.BROWSER_PROXY_API_KEYS = PROXY_KEY;
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
  __resetBrowserProxyKeysForTests();
});

async function seedUser(
  userId: string,
  row: { accessTier: "free" | "paid"; subscriptionTier: "solo" | "studio" | "team" | null },
) {
  await dbMod.db.insert(users).values({ id: userId, displayName: userId });
  await dbMod.db.insert(peUserEntitlements).values({
    ownerUserId: userId,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: row.accessTier,
    subscriptionTier: row.subscriptionTier,
  });
}

function userToken(userId: string): string {
  return mintSessionToken({
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: userId },
  });
}

const BBOX = { west: -97.4, south: 30.0, east: -97.39, north: 30.01 };

/** Exactly what hauska-map api/spine.ts sends for a (signed-in) visitor. */
function viaProxy(endUserToken?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${PROXY_KEY}`,
    ...(endUserToken ? { [END_USER_SESSION_HEADER]: endUserToken } : {}),
  };
}

function parcels(headers: Record<string, string>) {
  return request(getApp())
    .post("/api/brokerage/v1/map-data/gis-layer")
    .set(headers)
    .send({ layer: "parcels", bbox: BBOX });
}

type Feature = { properties: Record<string, unknown> };
const feats = (b: { geojson: { features: Feature[] } }) => b.geojson.features;

describe("signed-in visitor through the browser proxy gets THEIR OWN tier", () => {
  it("anonymous (no end-user session): public tier, no owner on any parcel", async () => {
    const res = await parcels(viaProxy());
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("free");
    for (const f of feats(res.body)) expect("owner" in f.properties).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("Solo: Solo's grant — no owner co-gated field (owner is Studio, not Solo)", async () => {
    const userId = "user_proxy_solo";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "solo" });
    const res = await parcels(viaProxy(userToken(userId)));
    expect(res.status).toBe(200);
    expect(res.body.packageTier).not.toBe("max");
    for (const f of feats(res.body)) expect("owner" in f.properties).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("Studio: Studio's grant — owner present on every parcel", async () => {
    const userId = "user_proxy_studio";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "studio" });
    const res = await parcels(viaProxy(userToken(userId)));
    expect(res.status).toBe(200);
    expect(res.body.packageTier).not.toBe("max");
    const fs = feats(res.body);
    expect(fs).toHaveLength(2);
    for (const f of fs) expect(f.properties.owner).toBe(SYNTH);
  });

  it("Studio via the proxy is still NOT Max: a Max-only layer is refused", async () => {
    const userId = "user_proxy_studio_not_max";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "studio" });
    const res = await request(getApp())
      .post("/api/brokerage/v1/map-data/gis-layer")
      .set(viaProxy(userToken(userId)))
      .send({ layer: "fema", bbox: BBOX });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tier_required");
  });

  it("an expired end-user session falls back to anonymous (never to the proxy's or anyone's tier)", async () => {
    const userId = "user_proxy_studio_expired";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "studio" });
    const expired = mintSessionToken(
      {
        audience: "user",
        tenantId: DEFAULT_TENANT_ID,
        requestor: { kind: "user", id: userId },
      },
      -60,
    );
    const res = await parcels(viaProxy(expired));
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("free");
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });
});

describe("metering is charged to the real end user", () => {
  const near = (headers: Record<string, string>) =>
    request(getApp())
      .get("/api/brokerage/v1/place/jurisdiction-boundaries/near-bbox")
      .query({ westLng: -97.4, southLat: 30.0, eastLng: -97.39, northLat: 30.01 })
      .set(headers);

  it("a proxied signed-in user is counted by the per-user daily limit", async () => {
    const userId = "user_proxy_metered";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "solo" });
    const res = await near(viaProxy(userToken(userId)));
    expect(res.status).toBe(200);
    expect(res.headers["x-hauska-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-hauska-ratelimit-used"]).toBe("1");
  });

  it("an anonymous proxied request is not attributed to any user", async () => {
    const res = await near(viaProxy());
    expect(res.status).toBe(200);
    expect(res.headers["x-hauska-ratelimit-used"]).toBeUndefined();
  });
});
