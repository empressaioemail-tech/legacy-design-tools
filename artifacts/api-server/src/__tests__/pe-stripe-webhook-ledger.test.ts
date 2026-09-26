/**
 * P-480 — Stripe webhook delivery ledger + entitlement history.
 *
 * Models the r14 commercial sequence: a paid Solo checkout ($1 of $49), then a
 * zero-dollar Studio promo for the same user. Both deliveries and both prior
 * entitlement states must remain readable; replay is a no-op on entitlements.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-stripe-webhook-ledger: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { handleStripeWebhook } = await import("../lib/brokerageStripe");
const {
  db,
  peUserEntitlements,
  peStripeWebhookEvents,
  peUserEntitlementHistory,
  users,
} = await import("@workspace/db");

setupRouteTests(() => undefined as never);

const USER = "user-p480-r14";
const WEBHOOK_SECRET = "whsec_test_p480_ledger";

const EVT_NONZERO = "evt_1UJAfIFjAepSMTX7ANeL090N";
const EVT_PROMO = "evt_1UJCl4FjAepSMTX7BPPypGW3";

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

function soloPaidCheckoutEvent(): Record<string, unknown> {
  return {
    id: EVT_NONZERO,
    livemode: true,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_live_b1OM4iW2LJB43j8PGDOlrqRNaYSLynjoUIEX1rr5oyZKhdvZExi9vmA9Qm",
        object: "checkout.session",
        amount_total: 100,
        currency: "usd",
        customer: "cus_p480_nonzero",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "solo",
        },
        total_details: { amount_discount: 4800 },
      },
    },
  };
}

function studioPromoCheckoutEvent(): Record<string, unknown> {
  return {
    id: EVT_PROMO,
    livemode: true,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_live_b1jQW44oJR3ZtOyvgvK9fYBXuIX5OoMwC1G6oQaRiegfqqz3L5sy8i66Xa",
        object: "checkout.session",
        amount_total: 0,
        currency: "usd",
        customer: "cus_p480_promo",
        metadata: {
          pe_user_id: USER,
          checkout_kind: "pe_sub",
          subscription_tier: "studio",
        },
        total_details: { amount_discount: 129000 },
      },
    },
  };
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SOLO_PRICE_ID = "price_test_solo";
  process.env.STRIPE_STUDIO_PRICE_ID = "price_test_studio";

  await db.insert(users).values({ id: USER, displayName: "P480 R14 User" });
  await db.insert(peUserEntitlements).values({
    ownerUserId: USER,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: "free",
  });
});

describe("P-480 webhook ledger (r14 sequence)", () => {
  it("keeps both deliveries and both entitlement states readable; replay is idempotent", async () => {
    const first = signedWebhookPayload(soloPaidCheckoutEvent());
    const firstResult = await handleStripeWebhook(first.raw, first.signature);
    expect(firstResult).toMatchObject({
      handled: true,
      eventType: "pe_subscription_active",
    });

    const second = signedWebhookPayload(studioPromoCheckoutEvent());
    const secondResult = await handleStripeWebhook(second.raw, second.signature);
    expect(secondResult).toMatchObject({
      handled: true,
      eventType: "pe_subscription_active",
    });

    const events = await db
      .select()
      .from(peStripeWebhookEvents)
      .where(eq(peStripeWebhookEvents.ownerUserId, USER))
      .orderBy(peStripeWebhookEvents.receivedAt);
    expect(events).toHaveLength(2);
    expect(events[0]?.stripeEventId).toBe(EVT_NONZERO);
    expect(events[0]?.amountTotalCents).toBe(100);
    expect(events[1]?.stripeEventId).toBe(EVT_PROMO);
    expect(events[1]?.amountTotalCents).toBe(0);
    expect(events[1]?.outcome).toBe("pe_subscription_active");

    const history = await db
      .select()
      .from(peUserEntitlementHistory)
      .where(eq(peUserEntitlementHistory.ownerUserId, USER))
      .orderBy(peUserEntitlementHistory.supersededAt);
    expect(history).toHaveLength(2);
    expect(history[0]?.accessTier).toBe("free");
    expect(history[0]?.stripeEventId).toBe(EVT_NONZERO);
    expect(history[0]?.subscriptionTier).toBeNull();
    expect(history[1]?.accessTier).toBe("paid");
    expect(history[1]?.subscriptionTier).toBe("solo");
    expect(history[1]?.entitlementSource).toBe("stripe_promo");
    expect(history[1]?.stripeEventId).toBe(EVT_PROMO);

    const [current] = await db
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, USER));
    expect(current?.subscriptionTier).toBe("studio");
    expect(current?.entitlementSource).toBe("stripe_promo");

    const replayFirst = await handleStripeWebhook(first.raw, first.signature);
    expect(replayFirst).toMatchObject({
      handled: true,
      eventType: "duplicate_replay",
    });
    const replaySecond = await handleStripeWebhook(second.raw, second.signature);
    expect(replaySecond).toMatchObject({
      handled: true,
      eventType: "duplicate_replay",
    });

    const eventsAfterReplay = await db
      .select()
      .from(peStripeWebhookEvents)
      .where(eq(peStripeWebhookEvents.ownerUserId, USER));
    expect(eventsAfterReplay).toHaveLength(2);

    const historyAfterReplay = await db
      .select()
      .from(peUserEntitlementHistory)
      .where(eq(peUserEntitlementHistory.ownerUserId, USER));
    expect(historyAfterReplay).toHaveLength(2);

    const [currentAfterReplay] = await db
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, USER));
    expect(currentAfterReplay?.subscriptionTier).toBe("studio");
  });
});
