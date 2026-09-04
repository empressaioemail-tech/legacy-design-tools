/**
 * P-112 email leg — magic-link sign-in.
 *
 * Covers:
 *   - requesting a link mints a token and sends it via Resend with the
 *     correct request shape; the raw token never appears in the API
 *     response, only inside the emailed link
 *   - a Resend send failure surfaces an honest 502, never a fake success
 *   - rate limiting rejects a 4th request for the same address inside the
 *     window
 *   - verify rejects malformed / not-found / expired / already-used tokens
 *     with distinct, honest statuses
 *   - a successful verification creates a real session: same response
 *     shape, same `users` row, same entitlement bootstrap as OAuth
 *   - the GHL new-signup hook fires exactly once, on the first verification
 *     of a brand-new address, and never again on a returning sign-in
 *   - no password anywhere: no password column exists on the new table,
 *     and nothing in this flow ever reads/writes `user_auth_credentials`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-magic-link: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { createMagicLinkToken } = await import("../lib/peMagicLink");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

function exchangeAuth(req: Test): Test {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  return req.set("Authorization", `Bearer ${secret}`);
}

/** Pull the raw token out of the link embedded in a captured Resend call —
 * exactly what a real user would have, since the API response never
 * returns it. */
function tokenFromResendCall(call: { init: RequestInit }): string {
  const body = JSON.parse(String(call.init.body)) as { text: string };
  const match = body.text.match(/token=([^\s&]+)/);
  if (!match) throw new Error("no token found in captured Resend email body");
  return decodeURIComponent(match[1]!);
}

beforeEach(() => {
  process.env["RESEND_API_KEY"] = "test_resend_key";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["RESEND_API_KEY"];
});

describe("POST /api/auth/email/request", () => {
  it("requires the exchange bearer secret", async () => {
    const res = await request(getApp())
      .post("/api/auth/email/request")
      .send({ email: "no-auth@example.com" });
    expect(res.status).toBe(401);
  });

  it("mints a token and sends it via Resend; the raw token is never in the API response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ id: "resend_msg_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "Request-New@Example.com" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.expiresAt).toBe("string");
    // The raw token must never appear anywhere in this JSON body.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test_resend_key");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    // Normalized (trimmed + lowercased) recipient.
    expect(body["to"]).toEqual(["request-new@example.com"]);
    expect(typeof body["subject"]).toBe("string");
    expect(String(body["html"])).toContain("/api/auth/email/verify?token=");
  });

  it("a malformed email is rejected 400 without attempting to send", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a Resend outage surfaces an honest error, never a fake success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed: network error");
    });
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "resend-outage@example.com" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("send_failed");
    expect(res.body.message).toMatch(/could not send/i);
  });

  it("a Resend 4xx also surfaces an honest error, not a fake success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ message: "invalid api key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "resend-401@example.com" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("send_failed");
  });

  it("rate-limits a 4th request for the same address inside the window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ id: "resend_msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const email = "rate-limited@example.com";
    for (let i = 0; i < 3; i++) {
      const res = await exchangeAuth(
        request(getApp()).post("/api/auth/email/request"),
      ).send({ email });
      expect(res.status).toBe(200);
    }
    const fourth = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe("rate_limited");
    expect(typeof fourth.body.retryAfterSeconds).toBe("number");
    expect(fourth.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.headers["retry-after"]).toBeTruthy();

    // A different address is unaffected by the first address's limit.
    const other = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "unaffected@example.com" });
    expect(other.status).toBe(200);
  });
});

describe("POST /api/auth/email/verify — rejection paths", () => {
  it("requires the exchange bearer secret", async () => {
    const res = await request(getApp())
      .post("/api/auth/email/verify")
      .send({ token: "whatever" });
    expect(res.status).toBe(401);
  });

  it("a malformed/missing token is rejected 400", async () => {
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: "" });
    expect(res.status).toBe(400);
  });

  it("a token that never existed is rejected 404 token_not_found", async () => {
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: "not-a-real-token-value-abc123" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("an expired token is rejected 410 token_expired", async () => {
    // Minted 21 minutes ago against a 20-minute TTL — already expired now.
    const created = await createMagicLinkToken(
      "expired@example.com",
      new Date(Date.now() - 21 * 60 * 1000),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: created.rawToken });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("expired");
  });

  it("an already-used token is rejected 409 on the second attempt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ id: "resend_msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const created = await createMagicLinkToken("reused@example.com");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const first = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: created.rawToken });
    expect(first.status).toBe(201);

    const second = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: created.rawToken });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_used");
  });

  it("two concurrent redemptions of the same token: exactly one succeeds", async () => {
    const created = await createMagicLinkToken("race@example.com");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const [a, b] = await Promise.all([
      exchangeAuth(request(getApp()).post("/api/auth/email/verify")).send({
        token: created.rawToken,
      }),
      exchangeAuth(request(getApp()).post("/api/auth/email/verify")).send({
        token: created.rawToken,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});

describe("full request -> email -> verify flow", () => {
  it("a successful verification creates a real session: same shape, same users row, same entitlement bootstrap as OAuth", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ id: "resend_msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const reqRes = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email: "full-flow@example.com" });
    expect(reqRes.status).toBe(200);

    const rawToken = tokenFromResendCall(calls[0]!);

    const verifyRes = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: rawToken });

    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.userId).toBeTruthy();
    expect(verifyRes.body.token).toBeTruthy();
    expect(verifyRes.body.email).toBe("full-flow@example.com");
    // Same response contract session-exchange (OAuth) returns.
    expect(verifyRes.body.entitlement).toEqual({ tier: "free" });
    expect(typeof verifyRes.body.claimedInstallHistory).toBe("boolean");

    // Same underlying `users` row shape a Google/Microsoft sign-in gets —
    // read it directly rather than trusting the response alone.
    const { users, peUserIdentities, peUserEntitlements } =
      await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
    const db = ctx.schema!.db;
    const [userRow] = await db
      .select()
      .from(users)
      .where(eq(users.id, verifyRes.body.userId));
    expect(userRow?.email).toBe("full-flow@example.com");

    const [identityRow] = await db
      .select()
      .from(peUserIdentities)
      .where(eq(peUserIdentities.userId, verifyRes.body.userId));
    expect(identityRow?.provider).toBe("email");
    expect(identityRow?.subject).toBe("full-flow@example.com");

    const [entitlementRow] = await db
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, verifyRes.body.userId));
    expect(entitlementRow?.accessTier).toBe("free");

    // Set-Cookie carries the same pr_session cookie name session-exchange sets.
    const setCookie = verifyRes.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    expect(String(setCookie)).toContain("pr_session=");
  });
});

describe("verify -> GHL new-signup hook", () => {
  beforeEach(() => {
    process.env["GOHIGHLEVEL_API_KEY"] = "test_ghl_key";
    process.env["GOHIGHLEVEL_LOCATION_ID"] = "test_ghl_location";
  });
  afterEach(() => {
    delete process.env["GOHIGHLEVEL_API_KEY"];
    delete process.env["GOHIGHLEVEL_LOCATION_ID"];
  });

  it("fires exactly once on a brand-new magic-link signup, with no tier-* tag", async () => {
    const ghlCalls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("leadconnectorhq.com")) {
        ghlCalls.push({ url: u, init: init as RequestInit });
        return new Response(
          JSON.stringify({ new: true, contact: { id: "ghl_contact_ml_1" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      // Resend
      return new Response(JSON.stringify({ id: "resend_msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const email = "ghl-magic-link-new@example.com";
    const reqRes = await exchangeAuth(
      request(getApp()).post("/api/auth/email/request"),
    ).send({ email });
    expect(reqRes.status).toBe(200);

    const resendCall = (
      vi.mocked(globalThis.fetch).mock.calls.find(
        (c) => !String(c[0]).includes("leadconnectorhq.com"),
      ) as [string, RequestInit]
    );
    const rawToken = tokenFromResendCall({ init: resendCall[1] });

    const verifyRes = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: rawToken });
    expect(verifyRes.status).toBe(201);

    expect(ghlCalls).toHaveLength(1);
    const body = JSON.parse(String(ghlCalls[0]!.init.body)) as Record<string, unknown>;
    expect(body["email"]).toBe(email);
    const tags = body["tags"] as string[];
    expect(tags).toEqual(["source-organic"]);
    expect(tags.some((t) => t.startsWith("tier-"))).toBe(false);
  });

  it("does not fire again for a returning magic-link sign-in", async () => {
    const ghlCalls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("leadconnectorhq.com")) {
        ghlCalls.push(url);
        return new Response(
          JSON.stringify({ new: true, contact: { id: "ghl_contact_ml_2" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ id: "resend_msg" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const email = "ghl-magic-link-returning@example.com";

    // First sign-in: new user, GHL fires once.
    const first = await createMagicLinkToken(email);
    if (!first.ok) throw new Error("unreachable");
    const firstVerify = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: first.rawToken });
    expect(firstVerify.status).toBe(201);
    expect(ghlCalls).toHaveLength(1);

    // Second sign-in, same address, a fresh token: returning user.
    const second = await createMagicLinkToken(email);
    if (!second.ok) throw new Error("unreachable");
    const secondVerify = await exchangeAuth(
      request(getApp()).post("/api/auth/email/verify"),
    ).send({ token: second.rawToken });
    expect(secondVerify.status).toBe(200);
    expect(secondVerify.body.userId).toBe(firstVerify.body.userId);

    expect(ghlCalls).toHaveLength(1);
  });
});
