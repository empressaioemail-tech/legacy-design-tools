import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
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

  it("does not exempt data routes", () => {
    expect(isUserRateLimitExemptPath("/api/session")).toBe(false);
    expect(isUserRateLimitExemptPath("/api/brokerage/v1/brief")).toBe(false);
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
});
