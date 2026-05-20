/**
 * Unit coverage for the L-surface service-token bearer middleware.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { requireServiceToken } from "../serviceAuth";
import { __resetServiceApiKeyCacheForTests } from "../../lib/serviceToken";
import { DEFAULT_TENANT_ID } from "../session";

const TOKEN = "test-service-token-abc123";

/** Minimal Express `Request` stub exposing a case-insensitive `header()`. */
function mockReq(headers: Record<string, string> = {}): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
  } as unknown as Request;
}

/** Minimal Express `Response` stub recording status + json payload. */
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
  process.env.SERVICE_API_KEY = TOKEN;
  __resetServiceApiKeyCacheForTests();
});

describe("requireServiceToken", () => {
  it("passes a request carrying the correct bearer token", () => {
    const req = mockReq({ authorization: `Bearer ${TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
    expect(req.serviceAuth).toEqual({ tenantId: DEFAULT_TENANT_ID });
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    const req = mockReq({ authorization: `bearer ${TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.serviceAuth).toEqual({ tenantId: DEFAULT_TENANT_ID });
  });

  it("rejects a missing Authorization header with 401", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: "unauthorized" });
    expect(req.serviceAuth).toBeUndefined();
  });

  it("rejects a wrong token with 401", () => {
    const req = mockReq({ authorization: "Bearer not-the-token" });
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: "unauthorized" });
  });

  it("rejects a non-Bearer scheme with 401", () => {
    const req = mockReq({ authorization: `Basic ${TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it("rejects an empty bearer value with 401", () => {
    const req = mockReq({ authorization: "Bearer " });
    const res = mockRes();
    const next = vi.fn();

    requireServiceToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});
