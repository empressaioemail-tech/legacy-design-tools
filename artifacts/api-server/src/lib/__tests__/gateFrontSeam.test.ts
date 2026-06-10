import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertServiceTenantScope,
  buildGateServiceAuth,
  readGateJurisdictionTenant,
} from "../gateFrontSeam";

function mockReq(headers: Record<string, string> = {}): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
  } as unknown as Request;
}

describe("gateFrontSeam", () => {
  it("reads jurisdiction tenant header", () => {
    const req = mockReq({ "x-hauska-jurisdiction-tenant": "bastrop_tx" });
    expect(readGateJurisdictionTenant(req)).toBe("bastrop_tx");
  });

  it("buildGateServiceAuth carries jurisdiction tenant on serviceAuth", () => {
    const req = mockReq({
      "x-hauska-jurisdiction-tenant": "mox-living",
      "x-hauska-platform-internal": "true",
    });
    expect(buildGateServiceAuth(req)).toEqual({
      tenantId: "default",
      jurisdictionTenant: "mox-living",
      platformInternal: true,
    });
  });

  it("assertServiceTenantScope denies cross-tenant service calls", () => {
    const req = mockReq();
    req.serviceAuth = {
      tenantId: "default",
      jurisdictionTenant: "bastrop_tx",
      platformInternal: false,
    };
    expect(assertServiceTenantScope(req, "elgin_tx")).toEqual({
      ok: false,
      error: "tenant_scope_denied",
    });
    expect(assertServiceTenantScope(req, "bastrop_tx")).toEqual({ ok: true });
  });

  it("platform-internal bypasses tenant equality", () => {
    const req = mockReq();
    req.serviceAuth = {
      tenantId: "default",
      jurisdictionTenant: "bastrop_tx",
      platformInternal: true,
    };
    expect(assertServiceTenantScope(req, "elgin_tx")).toEqual({ ok: true });
  });
});
