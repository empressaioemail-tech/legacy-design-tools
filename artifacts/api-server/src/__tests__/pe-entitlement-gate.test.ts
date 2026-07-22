/**
 * WDLL item 14 — deep-route tier gate (free vs paid vs anonymous).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, peUserEntitlements, users } from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-entitlement-gate: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const USER_FREE = "user-free";
const USER_PAID = "user-paid";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

function exchangeAuth(req: Test): Test {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  return req.set("Authorization", `Bearer ${secret}`);
}

describe("PE entitlement gate", () => {
  beforeEach(async () => {
    await db.insert(users).values([
      { id: USER_FREE, displayName: "Free User" },
      { id: USER_PAID, displayName: "Paid User" },
    ]);
    await db.insert(peUserEntitlements).values([
      {
        ownerUserId: USER_FREE,
        tenantId: DEFAULT_TENANT_ID,
        accessTier: "free",
      },
      {
        ownerUserId: USER_PAID,
        tenantId: DEFAULT_TENANT_ID,
        accessTier: "paid",
      },
    ]);
  });

  it("anonymous GET entitlement shows unauthenticated free tier", async () => {
    const res = await request(getApp()).get(
      "/api/property-explorer/v1/entitlement",
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.tier).toBe("free");
  });

  it("authed free user GET entitlement shows free tier", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER_FREE,
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.tier).toBe("free");
  });

  it("anonymous POST research/brief returns 401", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: "48055:10068" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_required");
  });

  it("authed free user POST research/brief returns 402", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: "48055:10068" }),
      USER_FREE,
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
  });

  it("authed paid user POST research/brief passes gate (503 scaffold)", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: "48055:10068" }),
      USER_PAID,
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("report_not_ready");
    expect(res.body.reportFamily).toBe("R1");
  });

  it("session-exchange mints token for verified BFF identity", async () => {
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-123",
      email: "pe.test@example.com",
      displayName: "PE Test",
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.userId).toMatch(/^u_/);
    expect(res.body.entitlement.tier).toBe("free");
  });

  it("session-exchange rejects missing exchange secret", async () => {
    const res = await request(getApp())
      .post("/api/auth/session-exchange")
      .send({
        provider: "google",
        subject: "google-subject-456",
        email: "bad@example.com",
      });
    expect(res.status).toBe(401);
  });
});
