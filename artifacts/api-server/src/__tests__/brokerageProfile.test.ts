/**
 * /api/brokerage/v1/profile — tenant-private buy-box teacher.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-profile";
const INSTALL_A = "install-profile-aaaaaaaa";
const INSTALL_B = "install-profile-bbbbbbbb";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageProfile.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

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
  "X-Hauska-Install-Id": INSTALL_A,
};

beforeAll(async () => {
  process.env.BROKERAGE_OPERATOR_API_KEYS = TEST_API_KEY;
  resetBrokerageApiKeysForTests();

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql41 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0041_brokerage_user_profiles.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql41);
});

describe("brokerage profile buy-box teacher", () => {
  it("GET /profile returns default buy box for install-scoped owner", async () => {
    const res = await request(getApp()).get("/api/brokerage/v1/profile").set(authHeaders);
    expect(res.status).toBe(200);
    expect(res.body.buyBox.capRateFloor).toBe(0.08);
    expect(res.body.kept).toBe(0);
    expect(res.body.passed).toBe(0);
    expect(res.body.ownerUserId).toBe(`install:${INSTALL_A}`);
  });

  it("POST /profile/verdict-action records keep and returns stats", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/profile/verdict-action")
      .set(authHeaders)
      .send({
        action: "keep",
        parcel_id: "clip-test-parcel-001",
        address: "1208 Walnut Ave, Austin, TX",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.kept).toBe(1);
    expect(res.body.passed).toBe(0);
  });

  it("PATCH /profile updates buy-box params", async () => {
    const res = await request(getApp())
      .patch("/api/brokerage/v1/profile")
      .set(authHeaders)
      .send({ buyBox: { capRateFloor: 0.1 } });
    expect(res.status).toBe(200);
    expect(res.body.buyBox.capRateFloor).toBe(0.1);
  });

  it("tenant isolation — install B cannot read install A profile", async () => {
    if (!ctx.schema) throw new Error("schema missing");
    const rowsA = await ctx.schema.pool.query(
      `SELECT owner_user_id FROM brokerage_user_profiles WHERE owner_user_id = $1`,
      [`install:${INSTALL_A}`],
    );
    expect(rowsA.rows.length).toBe(1);

    const resB = await request(getApp())
      .get("/api/brokerage/v1/profile")
      .set({
        ...authHeaders,
        "X-Hauska-Install-Id": INSTALL_B,
      });
    expect(resB.status).toBe(200);
    expect(resB.body.ownerUserId).toBe(`install:${INSTALL_B}`);
    expect(resB.body.kept).toBe(0);
  });
});
