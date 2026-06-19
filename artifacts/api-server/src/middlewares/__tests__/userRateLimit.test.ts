import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { userUsageMetering } from "@workspace/db";
import { isUserRateLimitExemptPath } from "../userRateLimit";
import { ctx } from "../../__tests__/test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("userRateLimit.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("../../__tests__/setup");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

describe("isUserRateLimitExemptPath", () => {
  it("exempts auth, health, and Stripe webhook paths", () => {
    expect(isUserRateLimitExemptPath("/api/auth/extension-login")).toBe(true);
    expect(isUserRateLimitExemptPath("/api/auth/hauska/hauska.css")).toBe(true);
    expect(isUserRateLimitExemptPath("/api/auth")).toBe(true);
    expect(isUserRateLimitExemptPath("/api/healthz")).toBe(true);
    expect(isUserRateLimitExemptPath("/api/health")).toBe(true);
    expect(isUserRateLimitExemptPath("/healthz")).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/billing/stripe/webhook"),
    ).toBe(true);
  });

  it("exempts high-frequency brokerage map and read paths", () => {
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/map-data", "POST"),
    ).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/map-data/gis-layer", "POST"),
    ).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/map-data/gis-layers", "GET"),
    ).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/entitlement", "GET"),
    ).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/coverage", "GET"),
    ).toBe(true);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/profile", "GET"),
    ).toBe(true);
  });

  it("still meters expensive brokerage writes and brief paths", () => {
    expect(isUserRateLimitExemptPath("/api/session")).toBe(false);
    expect(isUserRateLimitExemptPath("/api/brokerage/v1/brief", "POST")).toBe(
      false,
    );
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/research/chat", "POST"),
    ).toBe(false);
    expect(
      isUserRateLimitExemptPath("/api/brokerage/v1/profile", "PATCH"),
    ).toBe(false);
    expect(
      isUserRateLimitExemptPath(
        "/api/brokerage/v1/profile/verdict-action",
        "POST",
      ),
    ).toBe(false);
  });
});

describe("userRateLimitMiddleware exemptions", () => {
  const ownerId = "u-rate-limit-exempt";
  const periodStart = new Date().toISOString().slice(0, 10);

  async function seedExhaustedMeter(): Promise<void> {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(userUsageMetering).values({
      ownerUserId: ownerId,
      meterKey: "api_requests",
      periodStart,
      count: 5040,
    });
  }

  async function seedMeterCount(count: number): Promise<void> {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(userUsageMetering).values({
      ownerUserId: ownerId,
      meterKey: "api_requests",
      periodStart,
      count,
    });
  }

  async function meterCount(): Promise<number> {
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select({ count: userUsageMetering.count })
      .from(userUsageMetering)
      .where(
        and(
          eq(userUsageMetering.ownerUserId, ownerId),
          eq(userUsageMetering.meterKey, "api_requests"),
          eq(userUsageMetering.periodStart, periodStart),
        ),
      )
      .limit(1);
    return rows[0]?.count ?? 0;
  }

  it("still serves extension-login when the user meter is exhausted", async () => {
    await seedExhaustedMeter();

    const res = await request(getApp())
      .get("/api/auth/extension-login")
      .set("x-requestor", `user:${ownerId}`)
      .query({ intent: "signup", install_id: "test-install-00000001" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Create your account");
  });

  it("still rate-limits non-exempt routes when the user meter is exhausted", async () => {
    await seedExhaustedMeter();

    const res = await request(getApp())
      .get("/api/session")
      .set("x-requestor", `user:${ownerId}`);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
    expect(res.body.limit).toBe(5000);
    expect(res.body.used).toBe(5040);
  });

  it("does not increment api_requests when map-data gis-layer is called", async () => {
    await seedMeterCount(12);

    const before = await meterCount();

    const res = await request(getApp())
      .post("/api/brokerage/v1/map-data/gis-layer")
      .set("x-requestor", `user:${ownerId}`)
      .send({
        layer: "parcels",
        bbox: {
          westLng: -97.32,
          southLat: 30.1,
          eastLng: -97.3,
          northLat: 30.12,
        },
      });

    expect(res.status).not.toBe(429);
    expect(res.body.error).not.toBe("rate_limit_exceeded");
    expect(await meterCount()).toBe(before);
  });

  it("increments api_requests for metered brokerage brief posts", async () => {
    await seedMeterCount(12);

    const before = await meterCount();

    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set("x-requestor", `user:${ownerId}`)
      .send({});

    expect(res.status).not.toBe(429);
    expect(await meterCount()).toBe(before + 1);
  });
});
