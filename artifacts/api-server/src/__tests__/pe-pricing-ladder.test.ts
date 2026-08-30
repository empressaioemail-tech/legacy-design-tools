/**
 * LOCKED 2026-08-10 Smart Site pricing ladder — tier-aware checkout and
 * webhook entitlement mapping (2026-08-24 pricing-alignment remediation).
 *
 * Violation-direction coverage (enforcement: verify a check by violating it):
 *   - unknown tier string on the checkout body       -> 400, no session
 *   - configured Stripe but missing tier price env   -> 503 refusal, never
 *     another tier's price (the pre-ladder defect collapsed every checkout
 *     to the $29 STRIPE_PRO_PRICE_ID)
 *   - webhook subscription_tier unknown value        -> grant refused,
 *     entitlement unchanged
 *   - Solo grant must NOT read as Studio             -> subscription_tier
 *     column + subscriptionTierGrantsStudio both say no
 *   - expired $15 unlock                             -> not entitled
 *
 * Annual coverage (operator ruling 2026-08-24: Solo $490 / Studio $1,290 /
 * Team $2,990 per year, seats stay monthly):
 *   - each tier's annual env resolves independently of monthly
 *   - missing annual env on configured Stripe        -> 503, NEVER the
 *     monthly price (a different amount than presented)
 *   - interval "weekly"                              -> 400
 *   - annual Team with extra seats                   -> 400 (no annual seat
 *     price; Stripe cannot mix intervals in one subscription)
 *   - annual Solo grant does not clear Studio
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq, and } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  pePropertyUnlocks,
  peUserEntitlements,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-pricing-ladder: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { handleStripeWebhook } = await import("../lib/brokerageStripe");
const {
  stripePriceIdForPeTier,
  createPeSubscriptionCheckoutSession,
  PeCheckoutConfigError,
} = await import("../lib/pePaywallStripe");
const { subscriptionTierGrantsStudio, isPePropertyEntitled, createPePropertyUnlock } =
  await import("../lib/peEntitlement");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const USER = "user-ladder-a";
const WEBHOOK_SECRET = "whsec_test_pricing_ladder";

const SOLO_PRICE = "price_test_solo_49";
const STUDIO_PRICE = "price_test_studio_129";
const TEAM_PRICE = "price_test_team_299";
const SOLO_ANNUAL_PRICE = "price_test_solo_490yr";
const STUDIO_ANNUAL_PRICE = "price_test_studio_1290yr";
const TEAM_ANNUAL_PRICE = "price_test_team_2990yr";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

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
    data: { object: { id: "cs_test_ladder", object: "checkout.session", ...object } },
  };
}

async function entitlementRow() {
  const [row] = await db
    .select()
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, USER));
  return row;
}

beforeEach(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SOLO_PRICE_ID;
  delete process.env.STRIPE_STUDIO_PRICE_ID;
  delete process.env.STRIPE_TEAM_PRICE_ID;
  delete process.env.STRIPE_TEAM_SEAT_PRICE_ID;
  delete process.env.STRIPE_PE_UNLOCK_PRICE_ID;
  delete process.env.STRIPE_SOLO_ANNUAL_PRICE_ID;
  delete process.env.STRIPE_STUDIO_ANNUAL_PRICE_ID;
  delete process.env.STRIPE_TEAM_ANNUAL_PRICE_ID;
  // Legacy pre-ladder envs must never be read by the PE checkout path —
  // set them to sentinels so any read shows up as a wrong price id.
  process.env.STRIPE_PRO_PRICE_ID = "price_RETIRED_pro_29_must_not_be_used";
  process.env.STRIPE_MAX_PRICE_ID = "price_RETIRED_max_65_must_not_be_used";

  await db.insert(users).values({ id: USER, displayName: "Ladder Test User" });
  await db.insert(peUserEntitlements).values({
    ownerUserId: USER,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: "free",
  });
});

describe("tier -> price id resolution (fail closed)", () => {
  it("each tier resolves to its OWN env, never another tier's", () => {
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    process.env.STRIPE_STUDIO_PRICE_ID = STUDIO_PRICE;
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    expect(stripePriceIdForPeTier("solo")).toBe(SOLO_PRICE);
    expect(stripePriceIdForPeTier("studio")).toBe(STUDIO_PRICE);
    expect(stripePriceIdForPeTier("team")).toBe(TEAM_PRICE);
  });

  it("an unconfigured tier resolves to null — no fallback to the retired PRO/MAX ids", () => {
    // Only the retired envs are set (the pre-ladder production state).
    expect(stripePriceIdForPeTier("solo")).toBeNull();
    expect(stripePriceIdForPeTier("studio")).toBeNull();
    expect(stripePriceIdForPeTier("team")).toBeNull();
  });

  it("VIOLATION: configured Stripe + missing studio price -> refused, not solo-priced", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE; // solo IS configured
    await expect(
      createPeSubscriptionCheckoutSession({
        userId: USER,
        tier: "studio",
        successUrl: "https://x.example/?ok",
        cancelUrl: "https://x.example/?no",
      }),
    ).rejects.toThrowError(PeCheckoutConfigError);
  });

  it("VIOLATION: unknown tier refused even from a programmatic caller", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    await expect(
      createPeSubscriptionCheckoutSession({
        userId: USER,
        // @ts-expect-error — deliberately violating the type to prove the runtime guard
        tier: "platinum",
        successUrl: "https://x.example/?ok",
        cancelUrl: "https://x.example/?no",
      }),
    ).rejects.toThrowError(PeCheckoutConfigError);
  });
});

describe("annual billing (operator ruling 2026-08-24)", () => {
  it("each tier resolves its OWN annual env, distinct from monthly", () => {
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    process.env.STRIPE_STUDIO_PRICE_ID = STUDIO_PRICE;
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    process.env.STRIPE_SOLO_ANNUAL_PRICE_ID = SOLO_ANNUAL_PRICE;
    process.env.STRIPE_STUDIO_ANNUAL_PRICE_ID = STUDIO_ANNUAL_PRICE;
    process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = TEAM_ANNUAL_PRICE;
    expect(stripePriceIdForPeTier("solo", "year")).toBe(SOLO_ANNUAL_PRICE);
    expect(stripePriceIdForPeTier("studio", "year")).toBe(STUDIO_ANNUAL_PRICE);
    expect(stripePriceIdForPeTier("team", "year")).toBe(TEAM_ANNUAL_PRICE);
    // Monthly resolution is untouched by the annual envs.
    expect(stripePriceIdForPeTier("solo", "month")).toBe(SOLO_PRICE);
    expect(stripePriceIdForPeTier("solo")).toBe(SOLO_PRICE);
  });

  it("VIOLATION: missing annual env NEVER resolves to the monthly price", () => {
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE; // monthly IS configured
    expect(stripePriceIdForPeTier("solo", "year")).toBeNull();
  });

  it("VIOLATION: configured Stripe + interval=year + missing annual env -> 503, not monthly-billed", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE; // monthly configured; annual is not
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", interval: "year" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_SOLO_ANNUAL_PRICE_ID");
  });

  it("VIOLATION: unknown interval string rejected 400 (zod enum)", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", interval: "weekly" });
    expect(res.status).toBe(400);
  });

  it("VIOLATION: annual Team with extra seats rejected 400 (no annual seat price)", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "team", interval: "year", seats: 12 });
    expect(res.status).toBe(400);
  });

  it("annual Team within the included seats is accepted", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "team", interval: "year", seats: 3 });
    expect(res.status).toBe(200);
    expect(res.body.peTier).toBe("team");
    expect(res.body.peInterval).toBe("year");
  });

  it("simulated (keyless) checkout carries the interval through; absent defaults to month", async () => {
    const annual = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio", interval: "year" });
    expect(annual.status).toBe(200);
    expect(annual.body.peInterval).toBe("year");
    expect(annual.body.checkoutUrl).toContain("interval=year");

    const dflt = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio" });
    expect(dflt.body.peInterval).toBe("month");
  });
});

describe("checkout route tier handling", () => {
  it("rejects an unknown tier string with 400 (zod enum, fail closed)", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "platinum" });
    expect(res.status).toBe(400);
  });

  it("rejects seats on a non-team tier", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", seats: 5 });
    expect(res.status).toBe(400);
  });

  it("returns 503 checkout_unavailable when the requested tier's price is unconfigured", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_STUDIO_PRICE_ID");
  });

  it("simulated (keyless) checkout carries the requested tier through", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.peTier).toBe("studio");
    expect(res.body.checkoutUrl).toContain("tier=studio");
  });

  it("tierless body (deployed pre-tier PE client) defaults to solo, never studio/team", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.peTier).toBe("solo");
  });

  it("$15 unlock route: configured Stripe + missing STRIPE_PE_UNLOCK_PRICE_ID -> 503, never simulated", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const res = await asUser(
      request(getApp()).post(
        "/api/property-explorer/v1/billing/property-unlock/checkout",
      ),
      USER,
    ).send({ parcelNodeId: "48055:10068" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_PE_UNLOCK_PRICE_ID");
  });
});

function mockStripeCheckoutSession(payload: Record<string, unknown>): {
  spy: ReturnType<typeof vi.spyOn>;
  checkoutBodies: URLSearchParams[];
} {
  const checkoutBodies: URLSearchParams[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      const path = String(url);
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (path.includes("/customers")) {
        return new Response(JSON.stringify({ id: "cus_test_3b" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path.includes("/checkout/sessions")) {
        checkoutBodies.push(body);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: { message: `unexpected stripe path ${path}` } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });
  return { spy, checkoutBodies };
}

describe("custom / hosted checkout chrome (WDLL 3b items 1, 3 keep)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("simulated custom returns clientSecret + sessionId and NO checkoutUrl", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio", uiMode: "custom" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.peTier).toBe("studio");
    expect(res.body.sessionId).toMatch(/^cs_test_/);
    expect(res.body.clientSecret).toMatch(/^cs_test_.*_secret_sim$/);
    expect(res.body).toHaveProperty("publishableKey");
    expect(res.body.checkoutUrl).toBeUndefined();
  });

  it("uiMode elements posts Stripe ui_mode=elements (custom is a retired alias)", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio", uiMode: "elements" });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toMatch(/_secret_sim$/);
    expect(res.body.checkoutUrl).toBeUndefined();
  });

  it("embedded is the custom-path fallback: secret, no hosted URL", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", uiMode: "embedded" });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toMatch(/_secret_sim$/);
    expect(res.body.checkoutUrl).toBeUndefined();
  });

  it("hosted path still returns checkoutUrl when uiMode is absent", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio" });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toContain("tier=studio");
    expect(res.body.clientSecret).toBeUndefined();
  });

  it("hosted path still returns checkoutUrl when uiMode is hosted", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", uiMode: "hosted" });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toContain("checkout=success");
    expect(res.body.clientSecret).toBeUndefined();
  });

  it("unknown uiMode is 400 — never coerced to hosted", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", uiMode: "payment_intent" });
    expect(res.status).toBe(400);
  });

  it("custom + missing price ID is still 503 checkout_unavailable", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "studio", uiMode: "custom" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_unavailable");
    expect(res.body.missing).toBe("STRIPE_STUDIO_PRICE_ID");
  });

  it("VIOLATION: live custom session without client_secret is refused", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    mockStripeCheckoutSession({
      id: "cs_test_nosecret",
      url: "https://checkout.stripe.com/c/pay/cs_test_nosecret",
    });
    await expect(
      createPeSubscriptionCheckoutSession({
        userId: USER,
        tier: "solo",
        uiMode: "custom",
        successUrl: "https://x.example/?ok",
        cancelUrl: "https://x.example/?no",
      }),
    ).rejects.toThrow(/client_secret/);
  });

  it("live custom posts ui_mode + return_url, not success_url/cancel_url; 200 has secret and no checkoutUrl", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_3b";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    const { checkoutBodies } = mockStripeCheckoutSession({
      id: "cs_test_custom_ok",
      client_secret: "cs_test_custom_ok_secret_live",
      url: "https://checkout.stripe.com/c/pay/cs_test_custom_ok",
    });
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({
      tier: "solo",
      uiMode: "custom",
      returnUrl: "https://smartsite.cloud/checkout/return",
    });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("cs_test_custom_ok");
    expect(res.body.clientSecret).toBe("cs_test_custom_ok_secret_live");
    expect(res.body.publishableKey).toBe("pk_test_3b");
    expect(res.body.checkoutUrl).toBeUndefined();
    expect(checkoutBodies).toHaveLength(1);
    const form = checkoutBodies[0]!;
    expect(form.get("ui_mode")).toBe("elements");
    expect(form.get("return_url")).toContain("{CHECKOUT_SESSION_ID}");
    expect(form.get("return_url")).toContain("https://smartsite.cloud/checkout/return");
    expect(form.get("success_url")).toBeNull();
    expect(form.get("cancel_url")).toBeNull();
    expect(form.get("metadata[subscription_tier]")).toBe("solo");
  });

  it("live hosted still posts success_url + cancel_url and returns checkoutUrl", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_3b";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    const { checkoutBodies } = mockStripeCheckoutSession({
      id: "cs_test_hosted_ok",
      url: "https://checkout.stripe.com/c/pay/cs_test_hosted_ok",
    });
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER,
    ).send({ tier: "solo", uiMode: "hosted" });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_hosted_ok",
    );
    expect(res.body.clientSecret).toBeUndefined();
    expect(checkoutBodies).toHaveLength(1);
    const form = checkoutBodies[0]!;
    expect(form.get("success_url")).toBeTruthy();
    expect(form.get("cancel_url")).toBeTruthy();
    expect(form.get("ui_mode")).toBeNull();
    expect(form.get("return_url")).toBeNull();
  });

  it("team checkout declares seats_purchased = included + extras on session and subscription metadata", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_3b";
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    process.env.STRIPE_TEAM_SEAT_PRICE_ID = "price_test_team_seat_25";
    const { checkoutBodies } = mockStripeCheckoutSession({
      id: "cs_test_team_seats",
      url: "https://checkout.stripe.com/c/pay/cs_test_team_seats",
    });
    await createPeSubscriptionCheckoutSession({
      userId: USER,
      tier: "team",
      seats: 5,
      successUrl: "https://x.example/?ok",
      cancelUrl: "https://x.example/?no",
    });
    expect(checkoutBodies).toHaveLength(1);
    const form = checkoutBodies[0]!;
    expect(form.get("metadata[subscription_tier]")).toBe("team");
    expect(form.get("metadata[seats_purchased]")).toBe("5");
    expect(form.get("subscription_data[metadata][seats_purchased]")).toBe("5");
    expect(form.get("line_items[1][quantity]")).toBe("2");
  });

  it("solo checkout does not set seats_purchased metadata", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_3b";
    process.env.STRIPE_SOLO_PRICE_ID = SOLO_PRICE;
    const { checkoutBodies } = mockStripeCheckoutSession({
      id: "cs_test_solo_noseats",
      url: "https://checkout.stripe.com/c/pay/cs_test_solo_noseats",
    });
    await createPeSubscriptionCheckoutSession({
      userId: USER,
      tier: "solo",
      successUrl: "https://x.example/?ok",
      cancelUrl: "https://x.example/?no",
    });
    expect(checkoutBodies[0]!.get("metadata[seats_purchased]")).toBeNull();
  });
});

describe("webhook entitlement mapping (granular tiers)", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it("studio checkout grants access_tier=paid + subscription_tier=studio", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_1",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "studio",
        },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({ handled: true, eventType: "pe_subscription_active" });
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("paid");
    expect(row?.subscriptionTier).toBe("studio");
    expect(row?.seatsPurchased).toBeNull();
  });

  it("VIOLATION: solo checkout must NOT grant studio", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_2",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "solo",
        },
      }),
    );
    await handleStripeWebhook(raw, signature);
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("paid");
    expect(row?.subscriptionTier).toBe("solo");
    expect(subscriptionTierGrantsStudio(row?.subscriptionTier ?? null)).toBe(false);
    // The studio rungs DO grant studio — both directions observed.
    expect(subscriptionTierGrantsStudio("studio")).toBe(true);
    expect(subscriptionTierGrantsStudio("team")).toBe(true);
  });

  it("VIOLATION: unknown subscription_tier grants NOTHING and returns unhandled", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_3",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "platinum",
        },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({
      handled: false,
      reason: "unknown_subscription_tier:platinum",
    });
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("free");
    expect(row?.subscriptionTier).toBeNull();
  });

  it("annual solo checkout grants solo — VIOLATION: does not clear studio; interval never inflates the rung", async () => {
    // The grant keys off metadata.subscription_tier only; billing_interval
    // is observability metadata. An annual Solo is still Solo.
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_annual_1",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "solo",
          billing_interval: "year",
        },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({ handled: true, eventType: "pe_subscription_active" });
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("paid");
    expect(row?.subscriptionTier).toBe("solo");
    expect(subscriptionTierGrantsStudio(row?.subscriptionTier ?? null)).toBe(false);
  });

  it("legacy pro_sub session without subscription_tier maps to solo (never studio/team)", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_4",
        metadata: { pe_user_id: USER, checkout_kind: "pro_sub" },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({ handled: true, eventType: "pe_subscription_active" });
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("paid");
    expect(row?.subscriptionTier).toBe("solo");
  });

  it("customer.subscription.deleted with pe_user_id downgrades to free and clears the rung", async () => {
    // Arrange: paid studio user.
    await db
      .update(peUserEntitlements)
      .set({ accessTier: "paid", subscriptionTier: "studio" })
      .where(eq(peUserEntitlements.ownerUserId, USER));

    const { raw, signature } = signedWebhookPayload({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_ladder_1",
          object: "subscription",
          status: "canceled",
          metadata: { pe_user_id: USER, subscription_tier: "studio" },
        },
      },
    });
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({ handled: true, eventType: "pe_churned" });
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("free");
    expect(row?.subscriptionTier).toBeNull();
    expect(row?.seatsPurchased).toBeNull();
  });

  it("team checkout with billed extras writes seats_purchased=5", async () => {
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    process.env.STRIPE_TEAM_SEAT_PRICE_ID = "price_test_team_seat_25";
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_seats_12",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "team",
          seats_purchased: "5",
        },
        line_items: {
          data: [
            { price: { id: TEAM_PRICE }, quantity: 1 },
            { price: { id: "price_test_team_seat_25" }, quantity: 2 },
          ],
        },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({ handled: true, eventType: "pe_subscription_active" });
    const row = await entitlementRow();
    expect(row?.subscriptionTier).toBe("team");
    expect(row?.seatsPurchased).toBe(5);
  });

  it("VIOLATION: team grant with no billed items leaves seats_purchased null, not 3", async () => {
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_seats_unknown",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "team",
          seats_purchased: "10",
        },
      }),
    );
    await handleStripeWebhook(raw, signature);
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("paid");
    expect(row?.subscriptionTier).toBe("team");
    expect(row?.seatsPurchased).toBeNull();
  });

  it("VIOLATION: metadata 3 vs billed 5 refuses the seat write and still grants team", async () => {
    process.env.STRIPE_TEAM_PRICE_ID = TEAM_PRICE;
    process.env.STRIPE_TEAM_SEAT_PRICE_ID = "price_test_team_seat_25";
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_seats_disagree",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "team",
          seats_purchased: "3",
        },
        line_items: {
          data: [
            { price: { id: TEAM_PRICE }, quantity: 1 },
            { price: { id: "price_test_team_seat_25" }, quantity: 2 },
          ],
        },
      }),
    );
    await handleStripeWebhook(raw, signature);
    const row = await entitlementRow();
    expect(row?.subscriptionTier).toBe("team");
    expect(row?.seatsPurchased).toBeNull();
  });

  it("churn clears a planted seats_purchased", async () => {
    await db
      .update(peUserEntitlements)
      .set({
        accessTier: "paid",
        subscriptionTier: "team",
        seatsPurchased: 12,
      })
      .where(eq(peUserEntitlements.ownerUserId, USER));

    const { raw, signature } = signedWebhookPayload({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_seats_clear",
          object: "subscription",
          status: "canceled",
          metadata: { pe_user_id: USER, subscription_tier: "team" },
        },
      },
    });
    await handleStripeWebhook(raw, signature);
    const row = await entitlementRow();
    expect(row?.accessTier).toBe("free");
    expect(row?.seatsPurchased).toBeNull();
  });
});

describe("$15 unlock — 30-day bound (LOCKED: not forever)", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it("stripe unlock webhook writes expires_at ~= unlocked_at + 30 days", async () => {
    const before = Date.now();
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_5",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "property_unlock",
          parcel_node_id: "48055:10068",
        },
      }),
    );
    await handleStripeWebhook(raw, signature);

    const [row] = await db
      .select()
      .from(pePropertyUnlocks)
      .where(
        and(
          eq(pePropertyUnlocks.ownerUserId, USER),
          eq(pePropertyUnlocks.parcelNodeId, "48055:10068"),
        ),
      );
    expect(row?.source).toBe("stripe");
    const expires = row?.expiresAt?.getTime() ?? 0;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThanOrEqual(before + thirtyDays - 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + thirtyDays + 60_000);
    expect(await isPePropertyEntitled(USER, "48055:10068")).toBe(true);
  });

  it("VIOLATION: an expired unlock row does NOT entitle the property", async () => {
    await createPePropertyUnlock({
      ownerUserId: USER,
      parcelNodeId: "48055:99999",
      source: "stripe",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await isPePropertyEntitled(USER, "48055:99999")).toBe(false);
  });

  it("a null-expiry (legacy/dev) unlock stays valid", async () => {
    await createPePropertyUnlock({
      ownerUserId: USER,
      parcelNodeId: "48055:11111",
      source: "dev",
      expiresAt: null,
    });
    expect(await isPePropertyEntitled(USER, "48055:11111")).toBe(true);
  });

  it("a repurchase RENEWS an expired row rather than silently keeping the dead one", async () => {
    await createPePropertyUnlock({
      ownerUserId: USER,
      parcelNodeId: "48055:22222",
      source: "stripe",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await isPePropertyEntitled(USER, "48055:22222")).toBe(false);

    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_ladder_6",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "property_unlock",
          parcel_node_id: "48055:22222",
        },
      }),
    );
    await handleStripeWebhook(raw, signature);
    expect(await isPePropertyEntitled(USER, "48055:22222")).toBe(true);
  });
});

describe("/entitlement exposes the ladder rung", () => {
  it("paid studio user reads subscriptionTier=studio; paid legacy row reads solo", async () => {
    await db
      .update(peUserEntitlements)
      .set({ accessTier: "paid", subscriptionTier: "studio" })
      .where(eq(peUserEntitlements.ownerUserId, USER));
    const studio = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER,
    );
    expect(studio.status).toBe(200);
    expect(studio.body.tier).toBe("paid");
    expect(studio.body.subscriptionTier).toBe("studio");

    await db
      .update(peUserEntitlements)
      .set({ subscriptionTier: null })
      .where(eq(peUserEntitlements.ownerUserId, USER));
    const legacy = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER,
    );
    expect(legacy.body.subscriptionTier).toBe("solo");
  });

  it("free user reads subscriptionTier=null", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER,
    );
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(res.body.subscriptionTier).toBeNull();
  });
});
