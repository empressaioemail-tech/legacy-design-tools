/**
 * Stripe Pro checkout + portal + simulated activation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
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
const {
  handleStripeWebhook,
  subscriptionTierFromPriceId,
  createSubscriptionCheckoutSession,
  BrokerageCheckoutConfigError,
} = await import("../lib/brokerageStripe");

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

// ---------------------------------------------------------------------------
// FAIL CLOSED — the retired browser extension's Pro/Max tiers (OPS-16 A-061,
// operator ruling 2026-09: extension retired for months, not coming back).
//
// Two live-money defects this block proves fixed:
//   1. subscriptionTierFromPriceId defaulted ANY unrecognized price id to
//      "pro" — a Max subscriber whose price id did not match a stale/unset
//      STRIPE_MAX_PRICE_ID was silently downgraded to Pro entitlement rather
//      than refused.
//   2. createSubscriptionCheckoutSession returned a fake "simulated" session
//      whenever the tier's price id was empty, EVEN when a real (possibly
//      live) STRIPE_SECRET_KEY was configured — indistinguishable from a
//      genuine checkout to the caller.
//
// Violation-direction coverage throughout: each test proves the OLD
// behaviour would have granted/faked something, and the NEW behaviour
// refuses instead.
// ---------------------------------------------------------------------------

describe("legacy install-scoped tier resolution — FAIL CLOSED", () => {
  it("subscriptionTierFromPriceId: exact matches resolve; anything else is null, never a default 'pro'", () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_real_pro_29";
    process.env.STRIPE_MAX_PRICE_ID = "price_real_max_65";

    expect(subscriptionTierFromPriceId("price_real_pro_29")).toBe("pro");
    expect(subscriptionTierFromPriceId("price_real_max_65")).toBe("max");

    // The exact shape of the defect: a Max-looking price id that no longer
    // matches STRIPE_MAX_PRICE_ID (stale env, rotated id, wrong product)
    // must refuse, never fall through to "pro".
    expect(
      subscriptionTierFromPriceId("price_stale_max_pre_rotation"),
    ).toBeNull();
    expect(subscriptionTierFromPriceId("price_unrelated_product")).toBeNull();
    expect(subscriptionTierFromPriceId(null)).toBeNull();
    expect(subscriptionTierFromPriceId(undefined)).toBeNull();
  });

  it("subscriptionTierFromPriceId: neither tier env configured -> every price id refused", () => {
    delete process.env.STRIPE_PRO_PRICE_ID;
    delete process.env.STRIPE_MAX_PRICE_ID;
    expect(subscriptionTierFromPriceId("price_anything")).toBeNull();
  });

  it("VIOLATION: createSubscriptionCheckoutSession with a configured (real) key + missing price id refuses, never a simulated session", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_configured_but_no_price";
    delete process.env.STRIPE_PRO_PRICE_ID;

    await expect(
      createSubscriptionCheckoutSession({
        installId: INSTALL,
        tier: "pro",
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      }),
    ).rejects.toThrowError(BrokerageCheckoutConfigError);

    delete process.env.STRIPE_SECRET_KEY;
  });

  it("VIOLATION: createSubscriptionCheckoutSession with NO key at all still simulates (the legitimate keyless dev path is untouched)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRO_PRICE_ID;

    const session = await createSubscriptionCheckoutSession({
      installId: INSTALL,
      tier: "pro",
      successUrl: "https://extension.example/success",
      cancelUrl: "https://extension.example/cancel",
    });
    expect(session.mode).toBe("simulated");
  });

  it("POST /billing/checkout: configured Stripe + missing STRIPE_PRO_PRICE_ID -> 503 checkout_unavailable, never 200 simulated", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_configured_but_no_price";
    delete process.env.STRIPE_PRO_PRICE_ID;

    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set(authHeaders)
      .send({
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_PRO_PRICE_ID");
    expect(res.body.mode).toBeUndefined();
    expect(res.body.checkoutUrl).toBeUndefined();

    delete process.env.STRIPE_SECRET_KEY;
  });

  it("POST /billing/checkout: configured Stripe + missing STRIPE_MAX_PRICE_ID -> 503 for the max tier, names STRIPE_MAX_PRICE_ID specifically", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_configured_but_no_price";
    delete process.env.STRIPE_MAX_PRICE_ID;

    const res = await request(getApp())
      .post("/api/brokerage/v1/billing/checkout")
      .set(authHeaders)
      .send({
        tier: "max",
        successUrl: "https://extension.example/success",
        cancelUrl: "https://extension.example/cancel",
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_MAX_PRICE_ID");

    delete process.env.STRIPE_SECRET_KEY;
  });

  describe("webhook grant refusal (checkout.session.completed / customer.subscription.updated)", () => {
    const WEBHOOK_SECRET = "whsec_test_brokerage_legacy_fail_closed";

    function signedWebhookPayload(body: Record<string, unknown>): {
      raw: Buffer;
      signature: string;
    } {
      const raw = Buffer.from(JSON.stringify(body), "utf8");
      const timestamp = Math.floor(Date.now() / 1000);
      const signed = createHmac("sha256", WEBHOOK_SECRET)
        .update(`${timestamp}.${raw.toString("utf8")}`)
        .digest("hex");
      return { raw, signature: `t=${timestamp},v1=${signed}` };
    }

    function checkoutCompletedEvent(
      object: Record<string, unknown>,
    ): Record<string, unknown> {
      return {
        type: "checkout.session.completed",
        data: {
          object: { id: "cs_test_legacy_fail_closed", object: "checkout.session", ...object },
        },
      };
    }

    function subscriptionUpdatedEvent(
      object: Record<string, unknown>,
    ): Record<string, unknown> {
      return {
        type: "customer.subscription.updated",
        data: {
          object: { id: "sub_test_legacy_fail_closed", object: "subscription", ...object },
        },
      };
    }

    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_configured_webhook";
      process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      process.env.STRIPE_PRO_PRICE_ID = "price_real_pro_29";
      process.env.STRIPE_MAX_PRICE_ID = "price_real_max_65";
    });

    it("VIOLATION: checkout.session.completed with a price id matching neither configured tier refuses the grant — the Max subscriber is NOT silently downgraded to Pro", async () => {
      const { raw, signature } = signedWebhookPayload(
        checkoutCompletedEvent({
          client_reference_id: INSTALL,
          customer: "cus_legacy_fail_closed_1",
          subscription: null,
          items: {
            data: [
              { price: { id: "price_STALE_max_no_longer_configured" } },
            ],
          },
        }),
      );
      const result = await handleStripeWebhook(raw, signature);
      expect(result.handled).toBe(false);

      const [row] = await ctx.schema!.db
        .select()
        .from(brokerageWallets)
        .where(eq(brokerageWallets.installId, INSTALL));
      // Never silently granted "pro" — entitlement stays exactly as seeded
      // in beforeEach (null), not the pre-fix defect's "pro".
      expect(row?.subscriptionTier).toBeNull();
      expect(row?.subscriptionStatus).toBeNull();
    });

    it("CONTROL: checkout.session.completed with the correctly-configured Max price id still grants max (the fix does not break the real path)", async () => {
      const { raw, signature } = signedWebhookPayload(
        checkoutCompletedEvent({
          client_reference_id: INSTALL,
          customer: "cus_legacy_fail_closed_2",
          subscription: null,
          items: { data: [{ price: { id: "price_real_max_65" } }] },
        }),
      );
      const result = await handleStripeWebhook(raw, signature);
      expect(result.handled).toBe(true);

      const [row] = await ctx.schema!.db
        .select()
        .from(brokerageWallets)
        .where(eq(brokerageWallets.installId, INSTALL));
      expect(row?.subscriptionTier).toBe("max");
    });

    it("VIOLATION: customer.subscription.updated (active) with an unrecognized price id refuses the grant", async () => {
      await ctx.schema!.db
        .update(brokerageWallets)
        .set({ stripeSubscriptionId: "sub_test_legacy_fail_closed" })
        .where(eq(brokerageWallets.installId, INSTALL));

      const { raw, signature } = signedWebhookPayload(
        subscriptionUpdatedEvent({
          status: "active",
          customer: "cus_legacy_fail_closed_3",
          items: { data: [{ price: { id: "price_UNRECOGNIZED" } }] },
        }),
      );
      const result = await handleStripeWebhook(raw, signature);
      expect(result.handled).toBe(false);

      const [row] = await ctx.schema!.db
        .select()
        .from(brokerageWallets)
        .where(eq(brokerageWallets.installId, INSTALL));
      expect(row?.subscriptionTier).toBeNull();
    });
  });
});
