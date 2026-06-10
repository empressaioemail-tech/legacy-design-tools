/**
 * Unit coverage for brokerage service-token + extension dual auth.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  isBrokerageServiceCaller,
  requireBrokerageAuthOrServiceToken,
} from "../brokerageServiceAuth";
import { __resetServiceApiKeyCacheForTests } from "../../lib/serviceToken";
import { resetBrokerageApiKeysForTests } from "../brokerageAuth";
import { DEFAULT_TENANT_ID } from "../session";

const SERVICE_TOKEN = "test-service-token-abc123";
const BROKERAGE_KEY = "brokerage-test-key-001";

function mockReq(headers: Record<string, string> = {}): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
    headers: Object.fromEntries(lower),
  } as unknown as Request;
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
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_DEV_API_KEY = BROKERAGE_KEY;
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
});

describe("requireBrokerageAuthOrServiceToken", () => {
  it("accepts SERVICE_API_KEY bearer without brokerage key", () => {
    const req = mockReq({ authorization: `Bearer ${SERVICE_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    requireBrokerageAuthOrServiceToken(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.serviceAuth).toEqual({
      tenantId: DEFAULT_TENANT_ID,
      jurisdictionTenant: null,
      platformInternal: false,
    });
    expect(req.brokerageServiceCaller).toBe(true);
    expect(req.brokerageAuth).toBeUndefined();
  });

  it("accepts brokerage dev key bearer", () => {
    const req = mockReq({ authorization: `Bearer ${BROKERAGE_KEY}` });
    const res = mockRes();
    const next = vi.fn();

    requireBrokerageAuthOrServiceToken(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.brokerageAuth).toEqual({ tier: "dev" });
    expect(req.brokerageServiceCaller).toBeUndefined();
  });

  it("rejects unknown bearer token", () => {
    const req = mockReq({ authorization: "Bearer wrong-token" });
    const res = mockRes();
    const next = vi.fn();

    requireBrokerageAuthOrServiceToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: "unauthorized" });
  });
});

describe("isBrokerageServiceCaller", () => {
  it("returns true when brokerageServiceCaller is set", () => {
    const req = mockReq();
    req.brokerageServiceCaller = true;
    expect(isBrokerageServiceCaller(req)).toBe(true);
  });
});
