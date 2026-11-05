/**
 * The anonymous owner token never earns the brokerage user tier.
 *
 * `mintAnonymousOwnerToken` (lib/anonymousOwnerCookie.ts, the httpOnly
 * pr_anon_owner cookie) signs a session whose requestor is
 * { kind: "user", id: "anon_<hex>" }. brokerageAuth granted
 * { tier: "user" } to ANY verified token with requestor kind "user", so a
 * visitor who sent their own anon cookie value as a Bearer token was treated
 * as a signed-in brokerage user (profile row, ownerUserId = anon id).
 *
 * FALSIFIER: on main the anon token passes with tier "user".
 * Controls: a real user token still earns the tier; the predicate refuses
 * agents and blank ids.
 */
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @workspace/db reads DATABASE_URL at import; this test never queries it.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

import { mintAnonymousOwnerToken } from "../lib/anonymousOwnerCookie";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import * as auth from "../middlewares/brokerageAuth";

function call(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, header: () => undefined } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  auth.brokerageAuth(req, res, next);
  return { req, next: next as unknown as ReturnType<typeof vi.fn>, status };
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-secret-for-brokerage-anon-owner-0123456789");
});
afterEach(() => vi.unstubAllEnvs());

describe("brokerageAuth: the anonymous owner token is not a signed-in user", () => {
  it("FALSIFIER: an anon owner token sent as Bearer does not get tier user", () => {
    const token = mintAnonymousOwnerToken("anon_0123456789abcdef01234567");
    const { req } = call(token);
    expect(req.brokerageAuth?.tier).not.toBe("user");
    expect(auth.authenticatedBrokerageUserId(req)).toBeNull();
  });

  it("control: a real user session token still gets tier user", () => {
    const token = mintSessionToken({ audience: "user", tenantId: DEFAULT_TENANT_ID, requestor: { kind: "user", id: "u_198b96c5e03ad3332b4ef200" } });
    const { req, next } = call(token);
    expect(req.brokerageAuth?.tier).toBe("user");
    expect(next).toHaveBeenCalledOnce();
    expect(auth.authenticatedBrokerageUserId(req)).toBe("u_198b96c5e03ad3332b4ef200");
  });
});

describe("isIdentifiedUserSession", () => {
  it("is true only for a non-anon user id", () => {
    expect(auth.isIdentifiedUserSession({ requestor: { kind: "user", id: "u_1" } })).toBe(true);
    expect(auth.isIdentifiedUserSession({ requestor: { kind: "user", id: "anon_abc" } })).toBe(false);
    expect(auth.isIdentifiedUserSession({ requestor: { kind: "user", id: "  " } })).toBe(false);
    expect(auth.isIdentifiedUserSession({ requestor: { kind: "agent", id: "a_1" } })).toBe(false);
    expect(auth.isIdentifiedUserSession(undefined)).toBe(false);
  });
});
