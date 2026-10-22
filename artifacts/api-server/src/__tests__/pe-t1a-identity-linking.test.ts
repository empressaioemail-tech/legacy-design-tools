/**
 * T1-A falsifier — identity linking by VERIFIED email (ruling 3, AUTH-1).
 *
 * On origin/main a Google sign-in and an email sign-in for the same address
 * create two separate `users` rows. After T1-A the second identity attaches
 * to the first user, but only when the email is verified on BOTH sides:
 * Google's email_verified claim (forwarded by the BFF) or a redeemed email
 * link/code. Unverified and Microsoft emails never link.
 *
 * Uses the LEGACY link routes (/auth/email/request + verify {token}) on
 * purpose: they exist on origin/main, so a failure there is the missing
 * linking, not a missing route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, users, peUserIdentities } from "@workspace/db";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t1a-identity-linking: ctx.schema not set");
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

let resendBodies: string[] = [];
beforeEach(() => {
  process.env["RESEND_API_KEY"] = "test_resend_key";
  resendBodies = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) !== "https://api.resend.com/emails") {
      throw new Error(`unexpected outbound fetch in test: ${String(url)}`);
    }
    resendBodies.push(String((init as RequestInit).body));
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

async function googleSignIn(
  subject: string,
  email: string,
  emailVerified?: boolean,
): Promise<string> {
  const res = await exchangeAuth(
    request(getApp()).post("/api/auth/session-exchange"),
  ).send({
    provider: "google",
    subject,
    email,
    displayName: "G User",
    ...(emailVerified === undefined ? {} : { emailVerified }),
  });
  expect([200, 201]).toContain(res.status);
  return res.body.userId as string;
}

async function microsoftSignIn(subject: string, email: string): Promise<string> {
  const res = await exchangeAuth(
    request(getApp()).post("/api/auth/session-exchange"),
  ).send({ provider: "microsoft", subject, email, emailVerified: true });
  expect([200, 201]).toContain(res.status);
  return res.body.userId as string;
}

/** Legacy link flow: request, pull the token out of the captured email, verify. */
async function emailLinkSignIn(email: string): Promise<string> {
  const before = resendBodies.length;
  const req = await exchangeAuth(
    request(getApp()).post("/api/auth/email/request"),
  ).send({ email });
  expect(req.status).toBe(200);
  const body = JSON.parse(resendBodies[before]!) as { text: string };
  const token = decodeURIComponent(body.text.match(/token=([^\s&]+)/)![1]!);
  const res = await exchangeAuth(
    request(getApp()).post("/api/auth/email/verify"),
  ).send({ token });
  expect([200, 201]).toContain(res.status);
  return res.body.userId as string;
}

async function userCount(): Promise<number> {
  return (await db.select({ id: users.id }).from(users)).length;
}

describe("T1-A identity linking by verified email", () => {
  it("Google (email_verified) then email link with the same address gives ONE user", async () => {
    const googleUser = await googleSignIn("g-sub-1", "same@example.com", true);
    const emailUser = await emailLinkSignIn("same@example.com");
    expect(emailUser).toBe(googleUser);
    expect(await userCount()).toBe(1);
    const ids = await db
      .select({ provider: peUserIdentities.provider, verified: peUserIdentities.emailVerified })
      .from(peUserIdentities)
      .where(eq(peUserIdentities.userId, googleUser));
    expect(ids.map((i) => i.provider).sort()).toEqual(["email", "google"]);
    expect(ids.every((i) => i.verified)).toBe(true);
  });

  it("email link first, then Google (email_verified), still ONE user, case-insensitive", async () => {
    const emailUser = await emailLinkSignIn("Order@Example.com");
    const googleUser = await googleSignIn("g-sub-2", "order@example.COM", true);
    expect(googleUser).toBe(emailUser);
    expect(await userCount()).toBe(1);
  });

  it("an UNVERIFIED Google email does not link: two users", async () => {
    const emailUser = await emailLinkSignIn("unverified@example.com");
    const googleUser = await googleSignIn("g-sub-3", "unverified@example.com", false);
    expect(googleUser).not.toBe(emailUser);
    expect(await userCount()).toBe(2);
  });

  it("a Google sign-in with NO email_verified claim (pre-T1-A BFF) does not link", async () => {
    const emailUser = await emailLinkSignIn("noclaim@example.com");
    const googleUser = await googleSignIn("g-sub-4", "noclaim@example.com");
    expect(googleUser).not.toBe(emailUser);
  });

  it("an account created through an unverified email is never joined by proving that email later", async () => {
    const googleUser = await googleSignIn("g-sub-5", "victim@corp.example", false);
    const emailUser = await emailLinkSignIn("victim@corp.example");
    expect(emailUser).not.toBe(googleUser);
  });

  it("Microsoft never links, even if the caller claims emailVerified", async () => {
    const emailUser = await emailLinkSignIn("ms@example.com");
    const msUser = await microsoftSignIn("ms-sub-1", "ms@example.com");
    expect(msUser).not.toBe(emailUser);
  });

  it("a returning Google identity keeps its own user (no relinking on later sign-ins)", async () => {
    const a = await googleSignIn("g-sub-6", "back@example.com", true);
    const b = await googleSignIn("g-sub-6", "back@example.com", true);
    expect(b).toBe(a);
    expect(await userCount()).toBe(1);
  });
});
