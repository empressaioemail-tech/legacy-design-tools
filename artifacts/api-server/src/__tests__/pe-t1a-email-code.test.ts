/**
 * T1-A falsifier — email sign-in with a 6-digit code + a confirm link
 * (shared API contract; AUTH-2, AUTH-10, AUTH-12).
 *
 *  - POST /api/auth/email/start: 200 {sent:true}; one email with a 6-digit
 *    code AND a link to the confirm PAGE (/auth/email?t=…), never the
 *    consuming GET /api/auth/email/verify URL.
 *  - Only successful sends count toward the rate limit.
 *  - POST /api/auth/email/verify {email, code}: code_invalid /
 *    too_many_attempts / code_expired; success returns user + returnTo.
 *  - A GET on the link (the confirm page) never consumes the token.
 *  - returnTo is validated: anything but a same-site relative path is "/".
 *  - No real email: every Resend call is captured by a fetch mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, peMagicLinkTokens } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t1a-email-code: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

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

type Captured = { to: string[]; subject: string; text: string; html: string };
let sent: Captured[] = [];
let resendFails = false;

beforeEach(() => {
  process.env["RESEND_API_KEY"] = "test_resend_key";
  sent = [];
  resendFails = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) !== "https://api.resend.com/emails") {
      throw new Error(`unexpected outbound fetch in test: ${String(url)}`);
    }
    if (resendFails) {
      return new Response(JSON.stringify({ message: "resend down" }), { status: 500 });
    }
    sent.push(JSON.parse(String((init as RequestInit).body)) as Captured);
    return new Response(JSON.stringify({ id: "resend_msg" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["RESEND_API_KEY"];
});

function start(email: string, returnTo?: string) {
  return exchangeAuth(request(getApp()).post("/api/auth/email/start")).send({
    email,
    ...(returnTo === undefined ? {} : { returnTo }),
  });
}
function verify(body: Record<string, unknown>) {
  return exchangeAuth(request(getApp()).post("/api/auth/email/verify")).send(body);
}
function lastCode(): string {
  const m = sent[sent.length - 1]!.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error("no 6-digit code in the captured email");
  return m[1]!;
}
function lastLinkToken(): string {
  const m = sent[sent.length - 1]!.text.match(/\/auth\/email\?t=([^\s&]+)/);
  if (!m) throw new Error("no /auth/email?t= link in the captured email");
  return decodeURIComponent(m[1]!);
}
function wrongCode(right: string): string {
  return right === "000000" ? "111111" : "000000";
}

describe("POST /api/auth/email/start", () => {
  it("sends ONE email with a 6-digit code and a confirm-page link (no consuming GET link)", async () => {
    const res = await start("Code-User@Example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["code-user@example.com"]);
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(sent[0]!.text).toContain("/auth/email?t=");
    expect(sent[0]!.text).not.toContain("/api/auth/email/verify");
    expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
  });

  it("an invalid email shape is a 400 and sends nothing", async () => {
    const res = await start("not-an-email");
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("failed sends do NOT count toward the rate limit; successful ones do", async () => {
    resendFails = true;
    for (let i = 0; i < 4; i++) {
      const r = await start("flaky@example.com");
      expect(r.status).toBe(502);
    }
    resendFails = false;
    for (let i = 0; i < 3; i++) {
      const r = await start("flaky@example.com");
      expect(r.status).toBe(200);
    }
    const limited = await start("flaky@example.com");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/email/verify {email, code}", () => {
  it("the right code signs in and returns user + validated returnTo", async () => {
    await start("ok@example.com", "/p/48021:25420?tool=flood");
    const res = await verify({ email: "ok@example.com", code: lastCode() });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.returnTo).toBe("/p/48021:25420?tool=flood");
    expect(res.body.user).toMatchObject({
      email: "ok@example.com",
      plan: "free",
      planStatus: "none",
      providers: ["email"],
    });
    // A code works once.
    const again = await verify({ email: "ok@example.com", code: lastCode() });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("code_expired");
  });

  it("an off-site returnTo becomes /", async () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/api/auth/logout"]) {
      sent = [];
      await db.delete(peMagicLinkTokens);
      await start("redirect@example.com", bad);
      const res = await verify({ email: "redirect@example.com", code: lastCode() });
      expect(res.body.returnTo).toBe("/");
    }
  });

  it("a wrong code is code_invalid; the 5th wrong code locks the code (too_many_attempts)", async () => {
    await start("guess@example.com");
    const right = lastCode();
    for (let i = 0; i < 4; i++) {
      const r = await verify({ email: "guess@example.com", code: wrongCode(right) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("code_invalid");
    }
    const fifth = await verify({ email: "guess@example.com", code: wrongCode(right) });
    expect(fifth.body.error).toBe("too_many_attempts");
    const late = await verify({ email: "guess@example.com", code: right });
    expect(late.status).toBe(400);
    expect(late.body.error).toBe("too_many_attempts");
  });

  it("an expired code is code_expired", async () => {
    await start("late@example.com");
    const code = lastCode();
    await db
      .update(peMagicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(peMagicLinkTokens.email, "late@example.com"));
    const res = await verify({ email: "late@example.com", code });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("code_expired");
  });

  it("a newer email supersedes the older code", async () => {
    await start("twice@example.com");
    const first = lastCode();
    await start("twice@example.com");
    const second = lastCode();
    if (first !== second) {
      const old = await verify({ email: "twice@example.com", code: first });
      expect(old.status).toBe(400);
    }
    const ok = await verify({ email: "twice@example.com", code: second });
    expect([200, 201]).toContain(ok.status);
  });
});

describe("the confirm link: a GET never consumes it", () => {
  it("GET the confirm page twice, then POST the token: signs in; a second POST is link_used", async () => {
    await start("link@example.com", "/p/1");
    const token = lastLinkToken();

    for (let i = 0; i < 2; i++) {
      const page = await request(getApp()).get(
        `/api/auth/email/confirm?t=${encodeURIComponent(token)}`,
      );
      expect(page.status).toBe(200);
      expect(page.text).toContain("Finish signing in");
      expect(page.text).toMatch(/<form method="post" action="\/api\/auth\/email\/verify">/);
      expect(page.headers["cache-control"]).toContain("no-store");
    }
    const status = await request(getApp()).get(
      `/api/auth/email/confirm?t=${encodeURIComponent(token)}&format=json`,
    );
    expect(status.body).toEqual({ status: "valid", returnTo: "/p/1" });

    const ok = await verify({ token });
    expect([200, 201]).toContain(ok.status);
    expect(ok.body.returnTo).toBe("/p/1");

    const reuse = await verify({ token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("link_used");

    const after = await request(getApp())
      .get(`/api/auth/email/confirm?t=${encodeURIComponent(token)}`)
      .redirects(0);
    expect(after.status).toBe(302);
    expect(after.headers["location"]).toBe("/?auth_error=link_used&returnTo=%2Fp%2F1");
  });

  it("an unknown or expired link redirects with auth_error=link_expired", async () => {
    const res = await request(getApp())
      .get("/api/auth/email/confirm?t=nope")
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/?auth_error=link_expired");
    const post = await verify({ token: "nope" });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("link_expired");
  });
});
