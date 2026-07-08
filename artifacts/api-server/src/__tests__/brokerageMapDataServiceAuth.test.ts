/**
 * Test that brokerage service callers (hauska-mcp-server's SERVICE_API_KEY
 * bearer) can access map-data endpoints without tier checks. Follows the
 * same pattern as #232/#234/#236 where the service token gets reviewer/
 * operator-grade read access.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const SERVICE_TOKEN = "test-service-token-map-data";
const BROKERAGE_KEY = "brokerage-test-key-map-data";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("brokerageMapDataServiceAuth.test: ctx.schema not set");
      return ctx.schema.db;
    },
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

describe("GET /api/brokerage/v1/map-data/gis-layers", () => {
  it("returns 200 for service bearer (bypasses tier check)", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/map-data/gis-layers")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
    expect(Array.isArray(res.body.layers)).toBe(true);
  });

  it("returns 403 for anonymous request", async () => {
    const res = await request(getApp()).get(
      "/api/brokerage/v1/map-data/gis-layers",
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tier_required");
  });

  it("returns 403 for free-tier brokerage user (extension public key)", async () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "test-extension-public-key";
    resetBrokerageApiKeysForTests();

    const res = await request(getApp())
      .get("/api/brokerage/v1/map-data/gis-layers")
      .set("X-Hauska-Key", "test-extension-public-key");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tier_required");
  });
});

describe("GET /api/brokerage/v1/map-data/composite-layers", () => {
  it("returns 200 for service bearer (bypasses tier check)", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/map-data/composite-layers")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
    expect(Array.isArray(res.body.layers)).toBe(true);
  });

  it("returns 403 for anonymous request", async () => {
    const res = await request(getApp()).get(
      "/api/brokerage/v1/map-data/composite-layers",
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tier_required");
  });
});
