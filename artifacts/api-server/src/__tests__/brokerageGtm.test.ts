/**
 * /api/brokerage/v1/gtm/* — observation layer for Empressa wedge.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-gtm";
const INSTALL_ID = "test-install-00000001";

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
};

beforeAll(async () => {
  process.env.BROKERAGE_DEV_API_KEY = TEST_API_KEY;
  resetBrokerageApiKeysForTests();

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    join(here, "../../../../lib/db/drizzle/0028_gtm_observation_layer.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql);
});

describe("brokerage GTM", () => {
  it("POST /gtm/consent then GET consent", async () => {
    const app = getApp();
    const post = await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        consentVersion: "2026-05-26-v1",
        graphOptIn: false,
      });
    expect(post.status).toBe(200);
    expect(post.body.graphOptIn).toBe(false);

    const get = await request(app)
      .get(`/api/brokerage/v1/gtm/consent/${INSTALL_ID}`)
      .set(authHeaders);
    expect(get.status).toBe(200);
    expect(get.body.installId).toBe(INSTALL_ID);
  });

  it("POST /gtm/events requires consent", async () => {
    const app = getApp();
    const noConsent = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set(authHeaders)
      .send({
        installId: "no-consent-install-id",
        eventType: "brief_started",
      });
    expect(noConsent.status).toBe(403);

    await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        graphOptIn: true,
      });

    const ev = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        eventType: "extension_install",
        payload: { version: "0.4.3" },
      });
    expect(ev.status).toBe(201);
    expect(ev.body.eventId).toBeTruthy();
  });

  it("GET /gtm/digest returns counts", async () => {
    const app = getApp();
    const res = await request(app)
      .get("/api/brokerage/v1/gtm/digest")
      .set(authHeaders);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);
    expect(Array.isArray(res.body.eventCounts)).toBe(true);
  });
});
