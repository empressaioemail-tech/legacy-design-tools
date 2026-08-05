/**
 * WDLL 2026-08-05 (pe_paywall_stripe_promo_dev_role) items 2, 3, 4, 5, 6.
 *
 * Covers:
 *   - user-authenticated PE checkout routes (subscription + $15 unlock),
 *     simulated-mode shape and `pe_user_id` requiring auth
 *   - the shared Stripe webhook handler's PE routing: property-unlock write,
 *     subscription paid-tier write, promo-vs-full-price source detection,
 *     install-claim on completion
 *   - claim-local-state: saved-property merge (never overwrite/delete a
 *     server row) + workbench-state upsert
 *   - session-exchange claiming install history via header or body
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq, and } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  brokerageInstallClaims,
  brokerageWorkspaces,
  pePropertyUnlocks,
  peSavedProperties,
  peUserEntitlements,
  peWorkbenchState,
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
        throw new Error("pe-paywall-stripe: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { handleStripeWebhook } = await import("../lib/brokerageStripe");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const USER_A = "user-stripe-a";
const WEBHOOK_SECRET = "whsec_test_pe_paywall";

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
    data: { object: { id: "cs_test_1", object: "checkout.session", ...object } },
  };
}

beforeEach(async () => {
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_PRO_PRICE_ID;
  delete process.env.STRIPE_PE_UNLOCK_PRICE_ID;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  // Non-empty so isStripeConfigured() is true for webhook tests below, but
  // no real network calls happen for checkout.session.completed unless a
  // subscriptionId triggers a Stripe subscription fetch — the PE branches
  // return before that path is reached.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";

  await db.insert(users).values({ id: USER_A, displayName: "Stripe Test User" });
  await db
    .insert(peUserEntitlements)
    .values({ ownerUserId: USER_A, tenantId: DEFAULT_TENANT_ID, accessTier: "free" });
});

describe("PE checkout routes (WDLL item 3) — simulated mode (no Stripe keys)", () => {
  it("requires PE authentication", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/billing/checkout")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns a simulated subscription checkout session for a signed-in user", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/billing/checkout"),
      USER_A,
    );
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.checkoutUrl).toContain("checkout=success");
    expect(res.body.stripeConfigured).toBe(false);
  });

  it("$15 property-unlock checkout requires PE auth and a parcelNodeId", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const anon = await request(getApp())
      .post("/api/property-explorer/v1/billing/property-unlock/checkout")
      .send({ parcelNodeId: "48055:10068" });
    expect(anon.status).toBe(401);

    const badBody = await asUser(
      request(getApp()).post(
        "/api/property-explorer/v1/billing/property-unlock/checkout",
      ),
      USER_A,
    ).send({});
    expect(badBody.status).toBe(400);

    const ok = await asUser(
      request(getApp()).post(
        "/api/property-explorer/v1/billing/property-unlock/checkout",
      ),
      USER_A,
    ).send({ parcelNodeId: "48055:10068" });
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe("simulated");
    expect(ok.body.parcelNodeId).toBe("48055:10068");
  });
});

describe("Stripe webhook PE routing (WDLL item 5)", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it("property_unlock checkout writes a stripe-sourced unlock row", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_test_1",
        metadata: {
          pe_user_id: USER_A,
          checkout_kind: "property_unlock",
          parcel_node_id: "48055:10068",
        },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({
      handled: true,
      eventType: "pe_property_unlock",
      peUserId: USER_A,
    });

    const [row] = await db
      .select()
      .from(pePropertyUnlocks)
      .where(
        and(
          eq(pePropertyUnlocks.ownerUserId, USER_A),
          eq(pePropertyUnlocks.parcelNodeId, "48055:10068"),
        ),
      );
    expect(row?.source).toBe("stripe");
  });

  it("subscription checkout with no discount sets entitlement_source=stripe_sub", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_test_2",
        metadata: { pe_user_id: USER_A, checkout_kind: "pro_sub" },
        total_details: { amount_discount: 0 },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({
      handled: true,
      eventType: "pe_subscription_active",
      peUserId: USER_A,
    });

    const [row] = await db
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, USER_A));
    expect(row?.accessTier).toBe("paid");
    expect(row?.entitlementSource).toBe("stripe_sub");
    expect(row?.stripeCustomerId).toBe("cus_test_2");
  });

  it("subscription checkout WITH a promo discount sets entitlement_source=stripe_promo (acceptance item 2)", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_test_3",
        metadata: { pe_user_id: USER_A, checkout_kind: "pro_sub" },
        total_details: { amount_discount: 2900 },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result.handled).toBe(true);

    const [row] = await db
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, USER_A));
    expect(row?.accessTier).toBe("paid");
    expect(row?.entitlementSource).toBe("stripe_promo");
  });

  it("claims install history on checkout completion when metadata.install_id is present", async () => {
    const installId = "install-stripe-claim-1";
    await db.insert(brokerageWorkspaces).values({
      installId,
      listingKey: "lk-stripe-claim-1",
      address: "1 Test Way",
    });

    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_test_4",
        metadata: {
          pe_user_id: USER_A,
          checkout_kind: "pro_sub",
          install_id: installId,
        },
      }),
    );
    await handleStripeWebhook(raw, signature);

    const [claim] = await db
      .select()
      .from(brokerageInstallClaims)
      .where(eq(brokerageInstallClaims.installId, installId));
    expect(claim?.ownerUserId).toBe(USER_A);

    const [workspaceRow] = await db
      .select({ ownerUserId: brokerageWorkspaces.ownerUserId })
      .from(brokerageWorkspaces)
      .where(eq(brokerageWorkspaces.installId, installId));
    expect(workspaceRow?.ownerUserId).toBe(USER_A);
  });

  it("brokerage installId-only checkout (no pe_user_id) is unaffected", async () => {
    const { raw, signature } = signedWebhookPayload(
      checkoutCompletedEvent({
        customer: "cus_test_5",
        client_reference_id: "install-brokerage-only",
        metadata: { install_id: "install-brokerage-only" },
      }),
    );
    const result = await handleStripeWebhook(raw, signature);
    expect(result).toMatchObject({
      handled: true,
      eventType: "subscription_active",
      installId: "install-brokerage-only",
    });
    expect(result).not.toHaveProperty("peUserId");
  });
});

describe("claim-local-state (WDLL item 6)", () => {
  it("requires PE authentication", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/claim-local-state")
      .send({ savedProperties: [] });
    expect(res.status).toBe(401);
  });

  it("inserts local saved properties that don't yet exist on the server", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/claim-local-state"),
      USER_A,
    ).send({
      savedProperties: [
        { parcelNodeId: "48055:10068", label: "Local Label", snapshot: { note: "local" } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.claimedParcelNodeIds).toEqual(["48055:10068"]);

    const [row] = await db
      .select()
      .from(peSavedProperties)
      .where(
        and(
          eq(peSavedProperties.ownerUserId, USER_A),
          eq(peSavedProperties.parcelNodeId, "48055:10068"),
        ),
      );
    expect(row?.label).toBe("Local Label");
    expect(row?.snapshot).toMatchObject({ note: "local" });
  });

  it("never overwrites or drops an existing server row — merges instead", async () => {
    await db.insert(peSavedProperties).values({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: USER_A,
      parcelNodeId: "48055:20099",
      label: "Server Label",
      snapshot: { serverKey: "server-value" },
    });

    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/claim-local-state"),
      USER_A,
    ).send({
      savedProperties: [
        {
          parcelNodeId: "48055:20099",
          label: "Local Label Should Not Win",
          snapshot: { localKey: "local-value", serverKey: "should-not-overwrite" },
        },
      ],
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(peSavedProperties)
      .where(
        and(
          eq(peSavedProperties.ownerUserId, USER_A),
          eq(peSavedProperties.parcelNodeId, "48055:20099"),
        ),
      );
    // Server label wins (pre-existing, authenticated write).
    expect(row?.label).toBe("Server Label");
    // Snapshot is merged: local-only keys are added, server keys are preserved.
    expect(row?.snapshot).toMatchObject({
      localKey: "local-value",
      serverKey: "server-value",
    });
  });

  it("upserts workbenchToolState for the user", async () => {
    const first = await asUser(
      request(getApp()).post("/api/property-explorer/v1/claim-local-state"),
      USER_A,
    ).send({ workbenchToolState: { lastTool: "measure" } });
    expect(first.status).toBe(200);
    expect(first.body.workbenchToolStateSaved).toBe(true);

    const [row] = await db
      .select()
      .from(peWorkbenchState)
      .where(eq(peWorkbenchState.ownerUserId, USER_A));
    expect(row?.state).toMatchObject({ lastTool: "measure" });

    const second = await asUser(
      request(getApp()).post("/api/property-explorer/v1/claim-local-state"),
      USER_A,
    ).send({ workbenchToolState: { lastTool: "draw" } });
    expect(second.status).toBe(200);
    const [updated] = await db
      .select()
      .from(peWorkbenchState)
      .where(eq(peWorkbenchState.ownerUserId, USER_A));
    expect(updated?.state).toMatchObject({ lastTool: "draw" });
  });

  it("no workbenchToolState in body leaves workbenchToolStateSaved=false and writes nothing", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/claim-local-state"),
      USER_A,
    ).send({ savedProperties: [] });
    expect(res.status).toBe(200);
    expect(res.body.workbenchToolStateSaved).toBe(false);
    const rows = await db
      .select()
      .from(peWorkbenchState)
      .where(eq(peWorkbenchState.ownerUserId, USER_A));
    expect(rows).toHaveLength(0);
  });
});

describe("session-exchange claims install history (WDLL item 6)", () => {
  function exchangeAuth(req: Test): Test {
    const secret =
      process.env["PE_SESSION_EXCHANGE_SECRET"] ||
      process.env["SESSION_SECRET"] ||
      "test-session-secret";
    return req.set("Authorization", `Bearer ${secret}`);
  }

  it("claims install history when X-Hauska-Install-Id header is present", async () => {
    const installId = "install-session-exchange-claim-1";
    await db.insert(brokerageWorkspaces).values({
      installId,
      listingKey: "lk-session-exchange-claim-1",
      address: "2 Test Way",
    });

    const res = await exchangeAuth(
      request(getApp())
        .post("/api/auth/session-exchange")
        .set("X-Hauska-Install-Id", installId),
    ).send({
      provider: "google",
      subject: "google-subject-claim-1",
      email: "claim1@example.com",
    });
    expect(res.status).toBe(201);
    expect(res.body.claimedInstallHistory).toBe(true);

    const [claim] = await db
      .select()
      .from(brokerageInstallClaims)
      .where(eq(brokerageInstallClaims.installId, installId));
    expect(claim?.ownerUserId).toBe(res.body.userId);
  });

  it("claims install history from a body installId when no header is present", async () => {
    const installId = "install-session-exchange-claim-2";
    await db.insert(brokerageWorkspaces).values({
      installId,
      listingKey: "lk-session-exchange-claim-2",
      address: "3 Test Way",
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-claim-2",
      email: "claim2@example.com",
      installId,
    });
    expect(res.status).toBe(201);
    expect(res.body.claimedInstallHistory).toBe(true);
  });

  it("sign-in succeeds even when the install was already claimed by someone else", async () => {
    const installId = "install-session-exchange-claim-3";
    await db.insert(users).values({ id: "u_other_owner", displayName: "Other" });
    await db
      .insert(brokerageInstallClaims)
      .values({ installId, ownerUserId: "u_other_owner" });

    const res = await exchangeAuth(
      request(getApp())
        .post("/api/auth/session-exchange")
        .set("X-Hauska-Install-Id", installId),
    ).send({
      provider: "google",
      subject: "google-subject-claim-3",
      email: "claim3@example.com",
    });
    expect(res.status).toBe(201);
    expect(res.body.claimedInstallHistory).toBe(false);
  });

  it("no installId present — sign-in unaffected, claimedInstallHistory=false", async () => {
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-claim-4",
      email: "claim4@example.com",
    });
    expect(res.status).toBe(201);
    expect(res.body.claimedInstallHistory).toBe(false);
  });
});
