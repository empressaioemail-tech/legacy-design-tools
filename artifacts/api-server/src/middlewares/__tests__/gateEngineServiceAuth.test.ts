import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { requireGateEngineServiceAuth } from "../../middlewares/gateEngineServiceAuth";
import { __resetServiceApiKeyCacheForTests } from "../../lib/serviceToken";
import { DEFAULT_TENANT_ID } from "../../middlewares/session";

const SERVICE_TOKEN = "gate-engine-service-token";

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
  __resetServiceApiKeyCacheForTests();
});

describe("requireGateEngineServiceAuth", () => {
  it("accepts bearer service token and attaches jurisdiction tenant", () => {
    const req = mockReq({
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-hauska-jurisdiction-tenant": "bastrop_tx",
    });
    const res = mockRes();
    const next = vi.fn();

    requireGateEngineServiceAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.serviceAuth).toEqual({
      tenantId: DEFAULT_TENANT_ID,
      jurisdictionTenant: "bastrop_tx",
      platformInternal: false,
    });
  });

  it("passes through when no Authorization header (browser session path)", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    requireGateEngineServiceAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.serviceAuth).toBeUndefined();
  });

  it("rejects invalid bearer", () => {
    const req = mockReq({ authorization: "Bearer wrong" });
    const res = mockRes();
    const next = vi.fn();

    requireGateEngineServiceAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});
