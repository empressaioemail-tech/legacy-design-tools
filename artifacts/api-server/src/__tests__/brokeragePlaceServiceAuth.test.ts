/**
 * Brokerage place routes must accept service callers (SERVICE_API_KEY bearer).
 * The router's inner brokerageAuth only knows install/user auth and 401'd the
 * service Bearer even though the outer requireBrokerageAuthOrServiceToken had
 * already authenticated it (live-verified 2026-07-08: POST place/resolve -> 401
 * under the service key while POST brief -> 200). Same class as #232/#234/#236.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const SERVICE_TOKEN = "test-service-token-place";
const BROKERAGE_KEY = "brokerage-test-key-place";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("brokeragePlaceServiceAuth.test: ctx.schema not set");
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

describe("POST /api/brokerage/v1/place/resolve", () => {
  it("does not 401 a service bearer (inner brokerageAuth bypassed)", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ address: "1209 Main St, Bastrop, TX 78602" });

    // The resolve may succeed or fail downstream depending on geocode
    // fixtures, but it must get PAST auth: never 401.
    expect(res.status).not.toBe(401);
  });

  it("still 401s an anonymous request", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .send({ address: "1209 Main St, Bastrop, TX 78602" });

    expect(res.status).toBe(401);
  });

  it("still 400s an invalid body under the service bearer (route logic reached)", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
  });
});
