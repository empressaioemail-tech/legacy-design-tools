/**
 * P-129 -- GET /api/property-explorer/v1/subscription.
 *
 * WHY THIS ROUTE EXISTS. Settings > Plan "Renewal date" read "Not read" for
 * every account, always -- `pePaywallStripe.ts`'s doc comment above
 * `peBillingIntervalForPriceId` explains this repo deliberately never reads
 * Stripe's `current_period_end` because its shape moves with the API
 * version, and nothing pins one. This route is the live, request-time read
 * that fills that gap, and also feeds the cancellation flow's "is a
 * cancellation already scheduled" state before it sends a customer to the
 * hosted portal (A-062).
 *
 * WHAT THESE TESTS ARE FOR, and it is not coverage. Four properties are
 * load-bearing and each is asserted by a VIOLATION, not just a happy path:
 *
 *   1. The customer id comes from the SAME resolution A-062's portal route
 *      uses (`readPeStripeCustomerId`) -- never re-derived, never created as
 *      a side effect of a read.
 *   2. The Stripe API version is PINNED on this call, asserted from the
 *      actual request the fetch spy recorded, not eyeballed from the code.
 *   3. Every field is extracted defensively: a Stripe response missing
 *      `current_period_end` fails the whole read closed (502), never a
 *      fabricated or partial 200.
 *   4. "No subscription" (200, honest absence) and "could not check" (503/502)
 *      are different states and are asserted as different status codes --
 *      never collapsed into one silent 200.
 *
 * The Stripe seam is `globalThis.fetch`, spied the same way
 * `pe-billing-portal.test.ts` does it. The spy's default arm 404s any
 * unexpected path, which is what turns "no Stripe call was made for a free
 * user" from an unobserved assumption into a failing test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
        throw new Error("pe-subscription: ctx.schema not set");
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

const PAYING_USER = "user-sub-paying";
const PAYING_CUSTOMER = "cus_sub_paying";

const FREE_USER = "user-sub-free";

const SUB_PATH = "/api/property-explorer/v1/subscription";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

/** Unix seconds, ~30 days out -- readable as "a renewal date", not a magic number. */
const FUTURE_PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

type StripeCall = { path: string; headers: Record<string, string> };

/**
 * Every Stripe call the process makes, and what it answered. The default arm
 * is a 404 naming the path -- the mechanism behind "no Stripe call was made"
 * assertions actually failing instead of trivially passing.
 */
function mockStripe(
  subscriptionsPayload: Record<string, unknown> | ((path: string) => Record<string, unknown>),
  status = 200,
): { calls: StripeCall[] } {
  const calls: StripeCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    if (path.includes("/v1/subscriptions")) {
      const body =
        typeof subscriptionsPayload === "function"
          ? subscriptionsPayload(path)
          : subscriptionsPayload;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: { message: `unexpected stripe path ${path}` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  });
  return { calls };
}

function activeSub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_live_1",
    status: "active",
    current_period_end: FUTURE_PERIOD_END,
    cancel_at_period_end: false,
    ...overrides,
  };
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";

  await db.insert(users).values([
    { id: PAYING_USER, displayName: "Paying" },
    { id: FREE_USER, displayName: "Free" },
  ]);
  await db.insert(peUserEntitlements).values([
    {
      ownerUserId: PAYING_USER,
      tenantId: DEFAULT_TENANT_ID,
      accessTier: "paid",
      stripeCustomerId: PAYING_CUSTOMER,
    },
    // NO stripeCustomerId -- the ordinary state of every free account.
    { ownerUserId: FREE_USER, tenantId: DEFAULT_TENANT_ID, accessTier: "free" },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P-129 the route is MOUNTED, read from the app and not from a grep", () => {
  it("answers the subscription path (401 signed out) and 404s its neighbours", async () => {
    const mounted = await request(getApp()).get(SUB_PATH);
    expect(mounted.status).toBe(401);

    for (const neighbour of [
      "/api/property-explorer/v1/subscriptions",
      "/api/property-explorer/v1/subscription/status",
      "/api/property-explorer/v1/sub",
    ]) {
      const res = await request(getApp()).get(neighbour);
      expect(res.status).toBe(404);
    }
  });

  it("requires an authenticated PE session", async () => {
    const res = await request(getApp()).get(SUB_PATH);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_required");
  });
});

describe("P-129 item 1 -- customer resolution is REUSED, never re-derived or created", () => {
  it("a free user (no stripeCustomerId) gets an honest 200 absence, and Stripe is never called", async () => {
    const { calls } = mockStripe(activeSub());
    const res = await asUser(request(getApp()).get(SUB_PATH), FREE_USER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hasSubscription).toBe(false);
    // NOT MERELY UNASSERTED: Stripe was never reached at all, so no customer
    // could have been created as a side effect of this read.
    expect(calls).toEqual([]);
    expect(res.body.currentPeriodEnd).toBeUndefined();
  });

  it("a paying user's request resolves the SAME customer id A-062's portal route would", async () => {
    const { calls } = mockStripe(
      (path) => {
        expect(path).toContain(encodeURIComponent(PAYING_CUSTOMER));
        return { data: [activeSub()] };
      },
    );
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain(`customer=${encodeURIComponent(PAYING_CUSTOMER)}`);
  });
});

describe("P-129 item 2 -- the Stripe API version is PINNED on this call", () => {
  it("VIOLATION-style assertion: the recorded request carries an explicit Stripe-Version header", async () => {
    const { calls } = mockStripe({ data: [activeSub()] });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const version = calls[0].headers["Stripe-Version"];
    expect(version).toBeTruthy();
    // A literal, dated Stripe API version string -- not "latest", not unset.
    expect(version).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe("P-129 item 3 -- active subscription: only the named fields, extracted defensively", () => {
  it("returns hasSubscription, status, currentPeriodEnd (ISO), cancelAtPeriodEnd", async () => {
    mockStripe({ data: [activeSub({ status: "active", cancel_at_period_end: true })] });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(200);
    expect(res.body.hasSubscription).toBe(true);
    expect(res.body.status).toBe("active");
    expect(res.body.cancelAtPeriodEnd).toBe(true);
    expect(res.body.currentPeriodEnd).toBe(new Date(FUTURE_PERIOD_END * 1000).toISOString());
  });

  it("VIOLATION: the raw Stripe subscription object is NOT passed through", async () => {
    mockStripe({
      data: [
        activeSub({
          items: { data: [{ price: { id: "price_secret_internal" } }] },
          metadata: { pe_user_id: "should-not-leak" },
        }),
      ],
    });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(200);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("price_secret_internal");
    expect(bodyText).not.toContain("should-not-leak");
    expect(res.body.items).toBeUndefined();
    expect(res.body.metadata).toBeUndefined();
    expect(res.body.id).toBeUndefined();
  });

  it("VIOLATION: a subscription missing current_period_end fails the read CLOSED (502), never a fabricated date", async () => {
    mockStripe({
      data: [
        {
          id: "sub_malformed",
          status: "active",
          cancel_at_period_end: false,
          // current_period_end deliberately absent.
        },
      ],
    });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("subscription_check_failed");
    expect(res.body.currentPeriodEnd).toBeUndefined();
    expect(res.body.hasSubscription).toBeUndefined();
  });

  it("VIOLATION: cancel_at_period_end of the wrong type also fails closed", async () => {
    mockStripe({
      data: [
        {
          id: "sub_malformed2",
          status: "active",
          current_period_end: FUTURE_PERIOD_END,
          cancel_at_period_end: "false", // string, not boolean
        },
      ],
    });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("subscription_check_failed");
  });
});

describe("P-129 item 4 -- absence vs failure are DIFFERENT status codes, never collapsed", () => {
  it("a customer with only a canceled subscription is an honest 200 absence, not an error", async () => {
    mockStripe({
      data: [
        {
          id: "sub_done",
          status: "canceled",
          current_period_end: FUTURE_PERIOD_END - 60 * 60 * 24 * 365,
          cancel_at_period_end: false,
        },
      ],
    });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(200);
    expect(res.body.hasSubscription).toBe(false);
  });

  it("VIOLATION: two concurrent LIVE subscriptions is refused (502), never a guessed pick", async () => {
    mockStripe({
      data: [activeSub({ id: "sub_a" }), activeSub({ id: "sub_b", status: "trialing" })],
    });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("subscription_check_failed");
    expect(res.body.hasSubscription).toBeUndefined();
  });

  it("Stripe not configured is 503 subscription_unavailable -- distinct from the 200 no-subscription absence", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { calls } = mockStripe({ data: [activeSub()] });
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("subscription_unavailable");
    expect(res.body.hasSubscription).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("a raw Stripe error response is 502, never 500 and never a fabricated snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "No such customer" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const res = await asUser(request(getApp()).get(SUB_PATH), PAYING_USER);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("subscription_check_failed");
    expect(res.body.message).toMatch(/No such customer/);
  });
});
