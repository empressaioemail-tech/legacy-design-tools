/**
 * brokerageAuth.ts — extension_public tier retirement (operator ruling
 * 2026-09-07: "cut the chrome extension we don't need it"). Confirmed dead
 * in production before retiring: 248 brokerage_brief_runs total ever, zero
 * since 2026-08-09. These are pure unit tests (no DB, no Express app) —
 * the same retirement is also asserted at the route level in
 * brokerageBrief.test.ts against a real request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  brokerageAuth,
  loadBrokerageApiKeys,
  resetBrokerageApiKeysForTests,
  resolveBrokerageClientTier,
} from "./brokerageAuth";
import { mintSessionToken } from "../lib/sessionToken";

const ORIGINAL_ENV = { ...process.env };

function mockReq(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request;
}

function mockRes(): Response & { _status: number | null; _json: unknown } {
  const res = {
    _status: null as number | null,
    _json: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number | null; _json: unknown };
}

beforeEach(() => {
  resetBrokerageApiKeysForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetBrokerageApiKeysForTests();
});

describe("extension_public tier — retired", () => {
  it("BROKERAGE_EXTENSION_PUBLIC_KEY is never loaded as a recognized key, even when set", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    process.env.BROKERAGE_OPERATOR_API_KEYS = "operator-key-1";
    const keys = loadBrokerageApiKeys();
    expect(keys.has("some-real-extension-key")).toBe(false);
    expect(keys.has("operator-key-1")).toBe(true);
  });

  it("resolveBrokerageClientTier never returns extension_public, for any input including the real former key value", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    expect(resolveBrokerageClientTier("some-real-extension-key")).toBe("operator");
    expect(resolveBrokerageClientTier("anything-else")).toBe("operator");
    expect(resolveBrokerageClientTier("")).toBe("operator");
  });

  it("a lone BROKERAGE_EXTENSION_PUBLIC_KEY with no other keys configured leaves the key set empty (the 503 unconfigured path, not a live tier)", () => {
    process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = "some-real-extension-key";
    delete process.env.BROKERAGE_OPERATOR_API_KEYS;
    delete process.env.BROKERAGE_API_KEYS;
    const keys = loadBrokerageApiKeys();
    expect(keys.size).toBe(0);
  });
});

describe("brokerageAuth middleware — session-JWT path independent of the keys-configured gate", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
    delete process.env.BROKERAGE_OPERATOR_API_KEYS;
    delete process.env.BROKERAGE_API_KEYS;
    delete process.env.BROKERAGE_EXTENSION_PUBLIC_KEY;
  });

  it("a valid session token authenticates even with zero brokerage API keys configured — the real production shape today (no BROKERAGE_OPERATOR_API_KEYS/BROKERAGE_API_KEYS secret has ever been provisioned; retiring the only other key must not 503 real logged-in users)", () => {
    expect(loadBrokerageApiKeys().size).toBe(0);
    const token = mintSessionToken({
      audience: "user",
      tenantId: "default",
      requestor: { kind: "user", id: "user-123" },
    });
    const req = mockReq(`Bearer ${token}`);
    const res = mockRes();
    const next = vi.fn();

    brokerageAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.brokerageAuth).toEqual({ tier: "user" });
    expect(res._status).toBeNull();
  });

  it("a garbage bearer token with zero keys configured still gets the honest 503 unconfigured, not a 401", () => {
    const req = mockReq("Bearer not-a-real-token.no-dots-either");
    const res = mockRes();
    const next = vi.fn();

    brokerageAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({ error: "property_brief_api_unconfigured" });
  });

  it("an invalid dotted token (fails verification) with zero keys configured still 503s, not a false accept", () => {
    const req = mockReq("Bearer fake.notavalidtoken");
    const res = mockRes();
    const next = vi.fn();

    brokerageAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(503);
  });
});
