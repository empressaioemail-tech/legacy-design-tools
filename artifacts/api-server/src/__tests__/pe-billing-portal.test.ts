/**
 * A-062 — POST /api/property-explorer/v1/billing/portal.
 *
 * WHY THE ROUTE EXISTS. `apps/property-explorer/public/terms.html` states
 * verbatim: "You can cancel a paid plan through the Stripe billing flow in the
 * product." There was no such flow for a PE user. The only portal in the
 * codebase was `brokerageStripe.createBillingPortalSession`, keyed on an
 * EXTENSION INSTALL ID against `brokerage_wallets`. A PE subscriber's Stripe
 * customer lives on `pe_user_entitlements.stripe_customer_id`, a different
 * column on a different row about a different subject.
 *
 * WHAT THESE TESTS ARE FOR, and it is not coverage. Three properties of this
 * route are load-bearing and each is asserted by a VIOLATION, not by a happy
 * path:
 *
 *   1. The customer id comes from the SESSION. A caller-supplied one is
 *      REFUSED, not ignored — ignoring is the same security outcome with no
 *      evidence, so an attempt to open somebody else's portal would look
 *      exactly like an ordinary request in every log we keep.
 *   2. NO STRIPE CUSTOMER IS CREATED as a side effect of asking for a portal.
 *      `getOrCreatePeStripeCustomer` sits one identifier away from the read
 *      this route performs and would satisfy every "did we get an id" check
 *      while registering a Stripe customer for a free user who clicked
 *      "cancel" to see what it said. The fetch spy below answers 404 for
 *      `/customers`, so a call to it fails the test rather than passing
 *      silently.
 *   3. The `return_url` posted to Stripe is the one the CLIENT sent. The
 *      server has no default: `peWebAppBaseUrl()` falls back to the hardcoded
 *      `https://property-explorer-xi.vercel.app` and would land a Smart Site
 *      customer on a stale Vercel host after they cancel.
 *
 * The Stripe seam is `globalThis.fetch`, spied the same way
 * `pe-pricing-ladder.test.ts` does it. The spy's default arm returns 404 for
 * ANY unexpected Stripe path, which is what turns "no customer was created"
 * from an unobserved assumption into a failing test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
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
        throw new Error("pe-billing-portal: ctx.schema not set");
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

/** The customer this account owns. Everything below turns on THIS string. */
const PAYING_USER = "user-portal-paying";
const PAYING_CUSTOMER = "cus_paying_account";

/** A second, real account. Its customer is what an attacker would name. */
const OTHER_USER = "user-portal-other";
const OTHER_CUSTOMER = "cus_somebody_elses_account";

/** Signed in, never paid. The ORDINARY state, not an error. */
const FREE_USER = "user-portal-free";

const PORTAL_PATH = "/api/property-explorer/v1/billing/portal";
const RETURN_URL = "https://smartsite.cloud/?billing=portal-return";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

/**
 * Every Stripe call the process makes, and what it answered.
 *
 * The default arm is a 404 naming the path. That is the mechanism behind
 * acceptance item 2: a `/customers` POST does not quietly succeed here, it
 * makes `stripePostForm` throw and the route return 502, and the recorded
 * paths below say exactly which call was attempted.
 */
function mockStripe(portalPayload: Record<string, unknown>): {
  paths: string[];
  portalBodies: URLSearchParams[];
} {
  const paths: string[] = [];
  const portalBodies: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    paths.push(path);
    if (path.includes("/billing_portal/sessions")) {
      portalBodies.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify(portalPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: { message: `unexpected stripe path ${path}` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  });
  return { paths, portalBodies };
}

/** Did anything create a Stripe customer? Asked of the RECORD, not of intent. */
function createdACustomer(paths: string[]): boolean {
  return paths.some((p) => /\/v1\/customers\b/.test(p));
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  delete process.env.PE_WEB_APP_BASE_URL;
  delete process.env.PE_PORTAL_RETURN_HOSTS;

  await db.insert(users).values([
    { id: PAYING_USER, displayName: "Paying" },
    { id: OTHER_USER, displayName: "Other" },
    { id: FREE_USER, displayName: "Free" },
  ]);
  await db.insert(peUserEntitlements).values([
    {
      ownerUserId: PAYING_USER,
      tenantId: DEFAULT_TENANT_ID,
      accessTier: "paid",
      stripeCustomerId: PAYING_CUSTOMER,
    },
    {
      ownerUserId: OTHER_USER,
      tenantId: DEFAULT_TENANT_ID,
      accessTier: "paid",
      stripeCustomerId: OTHER_CUSTOMER,
    },
    // NO stripeCustomerId. Null, not an empty string — the two are different
    // states and the route's lookup trims, so a blank would also refuse.
    { ownerUserId: FREE_USER, tenantId: DEFAULT_TENANT_ID, accessTier: "free" },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A-062 the route is MOUNTED, read from the app and not from a grep", () => {
  it("answers the portal path (401 signed out) and 404s its neighbours", async () => {
    // THE ROUTE-TABLE READ. A mounted path that requires auth answers 401; an
    // unmounted one falls through to the app's 404. Asserting both is what
    // makes this a discrimination rather than a status guess — if the router
    // silently stopped mounting the route, the first expectation flips to 404
    // and matches the second.
    const mounted = await request(getApp()).post(PORTAL_PATH).send({});
    expect(mounted.status).toBe(401);

    for (const neighbour of [
      "/api/property-explorer/v1/billing/portal/session",
      "/api/property-explorer/v1/billing/portals",
      "/api/property-explorer/v1/billing",
    ]) {
      const res = await request(getApp()).post(neighbour).send({});
      expect(res.status).toBe(404);
    }
  });
});

describe("A-062 item 1 — the customer id comes from the SESSION", () => {
  it("VIOLATION: a body carrying ANOTHER user's customer id is REFUSED", async () => {
    // The exact attack. The session is a real paying account, so the request
    // would otherwise succeed; the only difference is the extra field. The
    // route must not honour it AND must not quietly ignore it.
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
      stripe_customer_id: OTHER_CUSTOMER,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("customer_id_not_accepted");
    expect(res.body.source).toBe("body.stripe_customer_id");
    // NOT MERELY IGNORED: Stripe was never reached at all.
    expect(paths).toEqual([]);
  });

  it("VIOLATION: every spelling of a body customer id is refused", async () => {
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    for (const key of [
      "customer",
      "customerId",
      "customer_id",
      "stripeCustomerId",
      "stripeCustomer",
    ]) {
      const res = await asUser(
        request(getApp()).post(PORTAL_PATH),
        PAYING_USER,
      ).send({ returnUrl: RETURN_URL, [key]: OTHER_CUSTOMER });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("customer_id_not_accepted");
    }
    expect(paths).toEqual([]);
  });

  it("VIOLATION: a QUERY customer id and a HEADER customer id are refused too", async () => {
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });

    const viaQuery = await asUser(
      request(getApp()).post(`${PORTAL_PATH}?customer=${OTHER_CUSTOMER}`),
      PAYING_USER,
    ).send({ returnUrl: RETURN_URL });
    expect(viaQuery.status).toBe(400);
    expect(viaQuery.body.error).toBe("customer_id_not_accepted");
    expect(viaQuery.body.source).toBe("query.customer");

    const viaHeader = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER)
      .set("x-stripe-customer-id", OTHER_CUSTOMER)
      .send({ returnUrl: RETURN_URL });
    expect(viaHeader.status).toBe(400);
    expect(viaHeader.body.error).toBe("customer_id_not_accepted");
    expect(viaHeader.body.source).toBe("header.x-stripe-customer-id");

    expect(paths).toEqual([]);
  });

  it("opens the portal on the SESSION's own customer, never a supplied one", async () => {
    const { paths, portalBodies } = mockStripe({
      url: "https://billing.stripe.com/p/session/live",
    });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.portalUrl).toBe("https://billing.stripe.com/p/session/live");
    expect(portalBodies).toHaveLength(1);
    // THE ASSERTION THE WHOLE ITEM RESTS ON.
    expect(portalBodies[0].get("customer")).toBe(PAYING_CUSTOMER);
    expect(portalBodies[0].get("customer")).not.toBe(OTHER_CUSTOMER);
    expect(createdACustomer(paths)).toBe(false);
  });

  it("requires an authenticated PE session", async () => {
    const res = await request(getApp()).post(PORTAL_PATH).send({ returnUrl: RETURN_URL });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_required");
  });
});

describe("A-062 item 2 — no customer is a DECLARED refusal, never a fabricated one", () => {
  it("409 no_billing_account, and NO Stripe customer is created", async () => {
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), FREE_USER).send({
      returnUrl: RETURN_URL,
    });

    // DECLARED, and each clause is a distinct requirement of the card.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_billing_account");
    expect(res.body.hasBillingAccount).toBe(false);
    expect(res.body.message).toMatch(/no billing history/i);

    // Not a 500.
    expect(res.status).not.toBe(500);
    // Not somebody else's portal.
    expect(res.body.portalUrl).toBeUndefined();
    // NOT A SIDE-EFFECT CUSTOMER. This is the assertion that separates a read
    // from getOrCreatePeStripeCustomer, and it is checked against the RECORD
    // of what was called rather than against the shape of the response.
    expect(createdACustomer(paths)).toBe(false);
    expect(paths).toEqual([]);

    // And the store still holds no customer for this user — nothing was
    // written behind our back either.
    const [row] = await db
      .select({ stripeCustomerId: peUserEntitlements.stripeCustomerId })
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, FREE_USER))
      .limit(1);
    expect(row?.stripeCustomerId ?? null).toBeNull();
  });

  it("the entitlement read tells the client which of the two states it is in", async () => {
    // The client needs the bit BEFORE it renders a control, or it would have
    // to probe this route to find out — a write-shaped request whose only
    // purpose is a read.
    const paying = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      PAYING_USER,
    );
    expect(paying.status).toBe(200);
    expect(paying.body.hasBillingAccount).toBe(true);
    // THE ID ITSELF IS NEVER ON THE WIRE — only the bit.
    expect(JSON.stringify(paying.body)).not.toContain(PAYING_CUSTOMER);

    const free = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      FREE_USER,
    );
    expect(free.status).toBe(200);
    expect(free.body.hasBillingAccount).toBe(false);
  });

  it("VIOLATION: the WITH-parcel response is unchanged — no new key leaked into it", async () => {
    // peEntitlementBaseBody is a pinned contract the PE BFF reads. A-062 adds
    // its field to the ACCOUNT body only.
    const res = await asUser(
      request(getApp()).get(
        "/api/property-explorer/v1/entitlement?parcelNodeId=48055:10068",
      ),
      PAYING_USER,
    );
    expect(res.status).toBe(200);
    expect("hasBillingAccount" in res.body).toBe(false);
  });
});

describe("A-062 item 4 — the return URL is the CLIENT's, and it is required", () => {
  it("posts the sent return_url to Stripe, unchanged", async () => {
    const { portalBodies } = mockStripe({
      url: "https://billing.stripe.com/p/session/live",
    });
    await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
    });
    expect(portalBodies[0].get("return_url")).toBe(RETURN_URL);
    // NOT the stale hardcoded default this card removes.
    expect(portalBodies[0].get("return_url")).not.toContain(
      "property-explorer-xi.vercel.app",
    );
  });

  it("VIOLATION: an ABSENT returnUrl is refused, never defaulted", async () => {
    // The neighbouring checkout routes default to peWebAppBaseUrl(), which
    // resolves to the stale Vercel host when PE_WEB_APP_BASE_URL is unset
    // (it is deleted in beforeEach, which is exactly that condition). This
    // route has no such arm, so the wrong destination is unreachable rather
    // than merely unlikely.
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(paths).toEqual([]);
  });

  it("VIOLATION: an off-host returnUrl is REFUSED, not rewritten", async () => {
    // Refused rather than silently corrected: a destination we changed without
    // saying so is the same defect as the stale default, one layer down.
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: "https://evil.example.com/collect",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("return_url_not_allowed");
    expect(paths).toEqual([]);
  });
});

describe("A-062 — the failure arms are declared, and none of them is 500", () => {
  it("Stripe unconfigured is 503, NEVER a simulated portal URL", async () => {
    // The install-scoped seam returns a fake `?simulated_portal=1` bounce.
    // Doing that here would hand a customer a URL that looks like a portal and
    // cancels nothing, which would make the terms sentence read true while
    // being false — the exact defect this card closes.
    delete process.env.STRIPE_SECRET_KEY;
    const { paths } = mockStripe({ url: "https://billing.stripe.com/p/session/x" });
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("portal_unavailable");
    expect(res.body.portalUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("simulated_portal");
    expect(paths).toEqual([]);
  });

  it("a Stripe error is 502, not 500 and not a fabricated portal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "No configuration provided" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("portal_failed");
    // The live-mode Customer Portal configuration is a separate operator step;
    // this is what its absence looks like, and it is declared rather than 500.
    expect(res.body.message).toMatch(/No configuration provided/);
    expect(res.body.portalUrl).toBeUndefined();
  });

  it("VIOLATION: a Stripe 200 with NO url is refused, not stringified", async () => {
    // The shipped install-scoped code read `String(session.url)`, which turns
    // undefined into the truthy seven-character string "undefined" — so its
    // `if (!portalUrl) throw` guard could never fire and a customer would be
    // sent to a page named "undefined". The shared primitive reads the field.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: "bps_1", object: "billing_portal.session" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const res = await asUser(request(getApp()).post(PORTAL_PATH), PAYING_USER).send({
      returnUrl: RETURN_URL,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("portal_failed");
    expect(res.body.message).toMatch(/missing url/i);
    expect(JSON.stringify(res.body)).not.toContain("undefined");
  });
});
