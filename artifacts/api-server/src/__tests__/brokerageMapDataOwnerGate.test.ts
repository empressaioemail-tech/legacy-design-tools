/**
 * Map-data owner co-gate — route level, real entitlement predicate.
 *
 * DEFECT (live, 2026-10-13): an anonymous browser POST to
 * `smartsite.cloud/api/spine/cortex/api/brokerage/v1/map-data/gis-layer`
 * `{layer:"parcels", bbox}` returned every parcel in the bbox with `owner`
 * populated. The hauska-map proxy attaches the cortex service key to every
 * request, the service key resolves to the Max package tier, and nothing on
 * this route gated owner. The FIRST case below is that exact request shape
 * (service bearer, no user) and fails on the pre-fix route.
 *
 * The gate reused is the owner-fact gate: `resolveOwnerFactCaller` (caller
 * half of `callerGrantsOwnerFact`) + `grantsOwnerCoGatedFields` (Studio|Team,
 * or an active Property Unlock on THAT parcel). Seeded into the per-file test
 * schema; the parcel source is mocked with SYNTHETIC features only.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const SERVICE_TOKEN = "test-service-token-map-data-owner-gate";
const BROKERAGE_KEY = "brokerage-test-key-map-data-owner-gate";
const MAX_INSTALL = "install-owner-gate-test";
const SYNTH = "SYNTHETIC-GATED-VALUE";
const PARCEL_A = "48999:1001";
const PARCEL_B = "48999:1002";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("brokerageMapDataOwnerGate.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

function synthParcel(nodeId: string) {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
    },
    properties: {
      provider: "txgio",
      countyFips: "48999",
      countyName: "Synthetic",
      apn: nodeId.split(":")[1],
      parcel_node_id: nodeId,
      situsAddress: "1 SYNTHETIC WAY",
      owner: SYNTH,
      ownerMailingAddress: SYNTH,
      marketValue: 1,
      landUseCode: "A1",
      notSurveyGrade: true,
    },
  };
}

vi.mock("../lib/brokerageGisLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisLayers")
  >("../lib/brokerageGisLayers");
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(async () => ({
      layer: "parcels",
      provider: "synthetic",
      adapterKey: "synthetic:parcels",
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

vi.mock("../lib/brokerageGisCompositeLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisCompositeLayers")
  >("../lib/brokerageGisCompositeLayers");
  return {
    ...actual,
    queryCompositeLayer: vi.fn(async () => ({
      payload: {
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: null,
              properties: {
                kind: "motivated-seller",
                countyFips: "48999",
                apn: "1001",
                motivatedSellerHeat: 1,
                absenteeEvidence: {
                  absentee: true,
                  ownerMailingAddress: SYNTH,
                  situsAddress: "1 SYNTHETIC WAY",
                  homesteadExempt: false,
                },
              },
            },
          ],
        },
      },
    })),
  };
});

const dbMod = await import("@workspace/db");
const { users, peUserEntitlements, pePropertyUnlocks } = dbMod;
const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);
const { mintSessionToken } = await import("../lib/sessionToken");
const { DEFAULT_TENANT_ID } = await import("../middlewares/session");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_API_KEYS = BROKERAGE_KEY;
  process.env.BROKERAGE_MAP_DATA_MAX_INSTALL_IDS = MAX_INSTALL;
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
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

function gisLayer(auth: string, install = false) {
  const r = request(getApp())
    .post("/api/brokerage/v1/map-data/gis-layer")
    .set("Authorization", `Bearer ${auth}`);
  if (install) r.set("X-Hauska-Install-Id", MAX_INSTALL);
  return r.send({ layer: "parcels", bbox: BBOX });
}

type Feature = { properties: Record<string, unknown> };
function features(body: { geojson: { features: Feature[] } }): Feature[] {
  return body.geojson.features;
}

describe("POST /map-data/gis-layer parcels — owner co-gate", () => {
  it("anonymous via the proxy (service bearer, no user): no owner key on ANY feature", async () => {
    const res = await gisLayer(SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
    const fs = features(res.body);
    expect(fs).toHaveLength(2);
    for (const f of fs) {
      expect("owner" in f.properties).toBe(false);
      expect("ownerMailingAddress" in f.properties).toBe(false);
      expect("marketValue" in f.properties).toBe(false);
      // Public fields survive.
      expect(f.properties.apn).toBeTruthy();
      expect(f.properties.parcel_node_id).toBeTruthy();
      expect(f.properties.situsAddress).toBe("1 SYNTHETIC WAY");
      expect(f.properties.landUseCode).toBe("A1");
    }
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("identified-only (no PE entitlement row): no owner key", async () => {
    const userId = "user_mapdata_identified_only";
    await dbMod.db.insert(users).values({ id: userId, displayName: userId });
    const res = await gisLayer(userToken(userId), true);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("Solo: no owner key", async () => {
    const userId = "user_mapdata_solo";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "solo" });
    const res = await gisLayer(userToken(userId), true);
    expect(res.status).toBe(200);
    for (const f of features(res.body)) {
      expect("owner" in f.properties).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("Studio: owner present on every parcel", async () => {
    const userId = "user_mapdata_studio";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "studio" });
    const res = await gisLayer(userToken(userId), true);
    expect(res.status).toBe(200);
    const fs = features(res.body);
    expect(fs).toHaveLength(2);
    for (const f of fs) {
      expect(f.properties.owner).toBe(SYNTH);
      expect(f.properties.ownerMailingAddress).toBe(SYNTH);
    }
  });

  it("free + active unlock on ONE parcel: owner on that parcel only", async () => {
    const userId = "user_mapdata_unlock";
    await seedUser(userId, { accessTier: "free", subscriptionTier: null });
    await dbMod.db.insert(pePropertyUnlocks).values({
      ownerUserId: userId,
      tenantId: DEFAULT_TENANT_ID,
      parcelNodeId: PARCEL_A,
      source: "stripe",
    });
    const res = await gisLayer(userToken(userId), true);
    expect(res.status).toBe(200);
    const byId = new Map(
      features(res.body).map((f) => [f.properties.parcel_node_id, f.properties]),
    );
    expect(byId.get(PARCEL_A)!.owner).toBe(SYNTH);
    expect("owner" in byId.get(PARCEL_B)!).toBe(false);
  });

  it("an EXPIRED unlock grants nothing", async () => {
    const userId = "user_mapdata_unlock_expired";
    await seedUser(userId, { accessTier: "free", subscriptionTier: null });
    await dbMod.db.insert(pePropertyUnlocks).values({
      ownerUserId: userId,
      tenantId: DEFAULT_TENANT_ID,
      parcelNodeId: PARCEL_A,
      source: "stripe",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await gisLayer(userToken(userId), true);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });
});

describe("POST /map-data/composite-layer motivated-seller — owner co-gate", () => {
  function composite(auth: string, install = false) {
    const r = request(getApp())
      .post("/api/brokerage/v1/map-data/composite-layer")
      .set("Authorization", `Bearer ${auth}`);
    if (install) r.set("X-Hauska-Install-Id", MAX_INSTALL);
    return r.send({ layer: "motivated-seller", bbox: BBOX });
  }

  it("anonymous via the proxy: no owner mailing address or exemption flag", async () => {
    const res = await composite(SERVICE_TOKEN);
    expect(res.status).toBe(200);
    const props = res.body.payload.geojson.features[0].properties;
    expect(props.absenteeEvidence.absentee).toBe(true);
    expect("ownerMailingAddress" in props.absenteeEvidence).toBe(false);
    expect("homesteadExempt" in props.absenteeEvidence).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("Studio: owner mailing address present", async () => {
    const userId = "user_mapdata_composite_studio";
    await seedUser(userId, { accessTier: "paid", subscriptionTier: "studio" });
    const res = await composite(userToken(userId), true);
    expect(res.status).toBe(200);
    expect(
      res.body.payload.geojson.features[0].properties.absenteeEvidence
        .ownerMailingAddress,
    ).toBe(SYNTH);
  });
});
