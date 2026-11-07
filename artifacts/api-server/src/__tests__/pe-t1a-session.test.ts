/**
 * T1-A falsifier — server-validated sessions (AUTH-7, AUTH-8, AUTH-9).
 *
 *  - GET /api/auth/session validates the token server-side and answers the
 *    contract shape.
 *  - POST /api/auth/logout revokes the session server-side: the same token
 *    then reads signedIn:false AND is refused by a gated route. Holds for a
 *    pre-`sid` (legacy) token too.
 *  - Sliding expiry: a live token older than a day comes back re-minted and
 *    the server-side expiry moves forward.
 *  - A session past its server-side expiry reads signedIn:false even while
 *    the token's own `exp` is in the future.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, users, peSessions } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t1a-session: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { mintSessionToken } = await import("../lib/sessionToken");
const { upsertPeOidcIdentity } = await import("../lib/peIdentity");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

afterEach(() => {
  vi.useRealTimers();
});

const GATED = "/api/property-explorer/v1/saved-properties";

/** A real sign-in through the exchange route, as the BFF does it. */
async function signIn(subject = "g-sess-1", email = "sess@example.com"): Promise<{ token: string; userId: string }> {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  const res = await request(getApp())
    .post("/api/auth/session-exchange")
    .set("Authorization", `Bearer ${secret}`)
    .send({ provider: "google", subject, email, emailVerified: true });
  expect([200, 201]).toContain(res.status);
  return { token: res.body.token as string, userId: res.body.userId as string };
}

function session(token?: string) {
  const r = request(getApp()).get("/api/auth/session");
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
}

describe("GET /api/auth/session", () => {
  it("no token: signedIn:false", async () => {
    const res = await session();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signedIn: false });
  });

  it("a forged token: signedIn:false", async () => {
    const res = await session("eyJhIjoxfQ.forged");
    expect(res.body).toEqual({ signedIn: false });
  });

  it("a live token: signedIn:true with the contract user shape", async () => {
    const { token, userId } = await signIn();
    const res = await session(token);
    expect(res.status).toBe(200);
    expect(res.body.signedIn).toBe(true);
    expect(res.body.user).toMatchObject({
      id: userId,
      email: "sess@example.com",
      plan: "free",
      planStatus: "none",
      providers: ["google"],
    });
    expect(typeof res.body.user.createdAt).toBe("string");
    // A fresh token is not re-minted.
    expect(res.body.session).toBeUndefined();
  });
});

describe("POST /api/auth/logout revokes server-side", () => {
  it("a revoked session reads signedIn:false and a gated route answers 401", async () => {
    const { token } = await signIn();
    const before = await request(getApp()).get(GATED).set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    const out = await request(getApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    const after = await session(token);
    expect(after.body).toEqual({ signedIn: false });
    const gated = await request(getApp()).get(GATED).set("Authorization", `Bearer ${token}`);
    expect(gated.status).toBe(401);
  });

  it("a pre-sid (legacy) token is revocable too", async () => {
    const identity = await upsertPeOidcIdentity({
      provider: "google",
      subject: "g-legacy",
      email: "legacy@example.com",
    });
    const legacy = mintSessionToken({
      audience: "user",
      tenantId: "default",
      requestor: { kind: "user", id: identity.userId },
    });
    expect((await session(legacy)).body.signedIn).toBe(true);
    await request(getApp()).post("/api/auth/logout").set("Authorization", `Bearer ${legacy}`);
    expect((await session(legacy)).body).toEqual({ signedIn: false });
    const gated = await request(getApp()).get(GATED).set("Authorization", `Bearer ${legacy}`);
    expect(gated.status).toBe(401);
  });
});

describe("sliding expiry", () => {
  it("a token older than a day is re-minted and the server-side expiry moves forward", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(twoDaysAgo);
    const { token } = await signIn("g-slide", "slide@example.com");
    vi.useRealTimers();

    const [row] = await db.select().from(peSessions);
    const oldExpiry = row!.expiresAt.getTime();

    const res = await session(token);
    expect(res.body.signedIn).toBe(true);
    expect(typeof res.body.session?.token).toBe("string");
    expect(res.body.session.token).not.toBe(token);
    const [after] = await db.select().from(peSessions).where(eq(peSessions.id, row!.id));
    expect(after!.expiresAt.getTime()).toBeGreaterThan(oldExpiry + 24 * 60 * 60 * 1000);

    // The re-minted token is live and bound to the SAME server-side session,
    // so logging out with it also kills the old one.
    const fresh = res.body.session.token as string;
    expect((await session(fresh)).body.signedIn).toBe(true);
    await request(getApp()).post("/api/auth/logout").set("Authorization", `Bearer ${fresh}`);
    expect((await session(token)).body).toEqual({ signedIn: false });
  });

  it("a session past its server-side expiry is signed out even though the token exp is in the future", async () => {
    const { token } = await signIn("g-exp", "exp@example.com");
    await db.update(peSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await session(token)).body).toEqual({ signedIn: false });
  });

  it("a deleted user's token reads signedIn:false", async () => {
    const { token, userId } = await signIn("g-gone", "gone@example.com");
    await db.delete(users).where(eq(users.id, userId));
    expect((await session(token)).body).toEqual({ signedIn: false });
  });
});
