/**
 * T1-A falsifier — POST /api/account/delete (App Review 5.1.1(v)).
 *
 * Stripe is MOCKED at the fetch layer (fake key, every api.stripe.com call
 * answered in-process); the test fails loudly on any other outbound call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, users, peSavedProperties, peUserEntitlements, peUserIdentities } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t1a-account-delete: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

type StripeCall = { method: string; url: string; body: string };
let stripeCalls: StripeCall[] = [];
let stripeDown = false;

beforeEach(() => {
  process.env["STRIPE_SECRET_KEY"] = "sk_test_fake_never_used";
  stripeCalls = [];
  stripeDown = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.stripe.com/v1/")) {
      throw new Error(`unexpected outbound fetch in test: ${u}`);
    }
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    stripeCalls.push({ method, url: u, body: String((init as RequestInit | undefined)?.body ?? "") });
    if (stripeDown) {
      return new Response(JSON.stringify({ error: { message: "stripe down" } }), { status: 500 });
    }
    if (method === "GET" && u.includes("/subscriptions?customer=")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "sub_live", status: "active", cancel_at_period_end: false, current_period_end: 2_000_000_000 },
            { id: "sub_old", status: "canceled", cancel_at_period_end: false, current_period_end: 1_000_000_000 },
          ],
        }),
        { status: 200 },
      );
    }
    if (method === "POST" && u.includes("/subscriptions/sub_live")) {
      return new Response(JSON.stringify({ id: "sub_live", cancel_at_period_end: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${u}` } }), { status: 404 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["STRIPE_SECRET_KEY"];
});

async function signIn(subject: string, email: string): Promise<{ token: string; userId: string }> {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  const res = await request(getApp())
    .post("/api/auth/session-exchange")
    .set("Authorization", `Bearer ${secret}`)
    .send({ provider: "google", subject, email, emailVerified: true });
  return { token: res.body.token as string, userId: res.body.userId as string };
}

function del(token: string | null, body: unknown) {
  const r = request(getApp()).post("/api/account/delete");
  return (token ? r.set("Authorization", `Bearer ${token}`) : r).send(body as object);
}

describe("POST /api/account/delete", () => {
  it("requires a session", async () => {
    const res = await del(null, { confirm: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("requires confirm:DELETE", async () => {
    const { token, userId } = await signIn("g-del-0", "keep@example.com");
    const res = await del(token, { confirm: "yes" });
    expect(res.status).toBe(400);
    expect((await db.select().from(users).where(eq(users.id, userId))).length).toBe(1);
  });

  it("cancels Stripe AT PERIOD END, deletes personal data, revokes every session", async () => {
    const { token, userId } = await signIn("g-del-1", "leaving@example.com");
    await db
      .update(peUserEntitlements)
      .set({ accessTier: "paid", subscriptionTier: "solo", stripeCustomerId: "cus_test_1" })
      .where(eq(peUserEntitlements.ownerUserId, userId));
    await db.insert(peSavedProperties).values({
      ownerUserId: userId,
      parcelNodeId: "48021:1",
      snapshot: {},
    });

    const res = await del(token, { confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const cancels = stripeCalls.filter((c) => c.method === "POST");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.url).toBe("https://api.stripe.com/v1/subscriptions/sub_live");
    expect(cancels[0]!.body).toBe("cancel_at_period_end=true");
    // Never an immediate cancel.
    expect(stripeCalls.some((c) => c.method === "DELETE")).toBe(false);

    expect((await db.select().from(users).where(eq(users.id, userId))).length).toBe(0);
    expect((await db.select().from(peUserIdentities).where(eq(peUserIdentities.userId, userId))).length).toBe(0);
    expect((await db.select().from(peSavedProperties).where(eq(peSavedProperties.ownerUserId, userId))).length).toBe(0);

    const s = await request(getApp()).get("/api/auth/session").set("Authorization", `Bearer ${token}`);
    expect(s.body).toEqual({ signedIn: false });
    // The dead token must not re-create the user through the profile backfill.
    await request(getApp())
      .get("/api/property-explorer/v1/saved-properties")
      .set("Authorization", `Bearer ${token}`);
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.select().from(users).where(eq(users.id, userId))).length).toBe(0);
  });

  it("if Stripe cannot cancel, nothing is deleted", async () => {
    const { token, userId } = await signIn("g-del-2", "stuck@example.com");
    await db
      .update(peUserEntitlements)
      .set({ stripeCustomerId: "cus_test_2" })
      .where(eq(peUserEntitlements.ownerUserId, userId));
    stripeDown = true;
    const res = await del(token, { confirm: "DELETE" });
    expect(res.status).toBe(502);
    expect((await db.select().from(users).where(eq(users.id, userId))).length).toBe(1);
    const s = await request(getApp()).get("/api/auth/session").set("Authorization", `Bearer ${token}`);
    expect(s.body.signedIn).toBe(true);
  });

  it("a free user with no Stripe customer never calls Stripe", async () => {
    const { token } = await signIn("g-del-3", "free@example.com");
    const res = await del(token, { confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(stripeCalls).toHaveLength(0);
  });
});
