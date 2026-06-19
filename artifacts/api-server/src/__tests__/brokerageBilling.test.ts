/**
 * Stripe Pro checkout + portal + simulated activation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

const EXT_KEY = "brokerage-billing-ext-public-key";
const INSTALL = "install-billing-checkout-test";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/brokeragePipedrive", () => ({
  syncPipedriveDeal: vi.fn(async () => ({ mode: "simulated" })),
}));

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { brokerageWallets } = await import("@workspace/db");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  "X-Hauska-Key": EXT_KEY,
  "X-Hauska-Install-Id": INSTALL,
  "Content-Type": "application/json",
};

beforeEach(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRO_PRICE_ID;
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = EXT_KEY;
  resetBrokerageApiKeysForTests();

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql42 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0042_brokerage_entitlements.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql42);
  await ctx.schema.db
    .insert(brokerageWallets)
    .values({ installId: INSTALL, balanceCents: 0, updatedAt: new Date() })
    .onConflictDoNothing();
  await ctx.schema.db
    .update(brokerageWallets)
    .set({
      subscriptionTier: null,
      subscriptionStatus: null,
      subscriptionPeriodEnd: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      freeBriefsUsed: 0,
    })
    .where(eq(brokerageWallets.installId, INSTALL));
});

describe("brokerage billing (simulated)", () => {
  it("GET /billing/checkout-complete returns public HTML without auth", async () => {
    const res = await request(getApp()).get(
      "/api/brokerage/v1/billing/checkout-complete",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Payment complete");
  });

  it("POST /billing/checkout defaults success/cancel URLs to cortex-api landing pages", async () => {
    process.env.BROKERAGE_BILLING_PUBLIC_BASE_URL =
      "https://cortex-api-test.example";

    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set(authHeaders)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toContain(
      "https://cortex-api-test.example/api/brokerage/v1/billing/checkout-complete",
    );
  });

  it("POST /billing/checkout returns simulated checkoutUrl", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set(authHeaders)
      .send({
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.checkoutUrl).toContain("https://extension.example/success");
    expect(res.body.checkoutUrl).toContain("simulated=1");
    expect(res.body.sessionId).toMatch(/^sim_cs_/);
  });

  it("POST /billing/checkout/complete-simulated flips proActive", async () => {
    const checkout = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set(authHeaders)
      .send({
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      });
    expect(checkout.status).toBe(200);

    const complete = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout/complete-simulated")
      .set(authHeaders)
      .send({ sessionId: checkout.body.sessionId });
    expect(complete.status).toBe(200);
    expect(complete.body.proActive).toBe(true);

    const ent = await request(getApp())
      .get("/api/brokerage/v1/entitlement")
      .set(authHeaders);
    expect(ent.status).toBe(200);
    expect(ent.body.proActive).toBe(true);
  });

  it("POST /billing/portal returns simulated portalUrl when keyless", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/portal")
      .set(authHeaders)
      .send({ returnUrl: "https://extension.example/settings" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.portalUrl).toContain("simulated_portal=1");
  });

  it("requires X-Hauska-Install-Id", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set({ "X-Hauska-Key": EXT_KEY, "Content-Type": "application/json" })
      .send({
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      });
    expect(res.status).toBe(400);
  });
});
