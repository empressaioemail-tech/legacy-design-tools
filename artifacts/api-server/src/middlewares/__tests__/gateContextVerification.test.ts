import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { verifyGateContext } from "../gateContextVerification";
import { createHmac } from "node:crypto";
import type { GateContext } from "../../lib/gateContextVerify";

const TEST_KEY = "test-signing-key-middleware";

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function canonicalJson(obj: GateContext): string {
  return JSON.stringify({
    v: obj.v,
    tenant: obj.tenant,
    product: obj.product,
    tier: obj.tier,
    keyId: obj.keyId,
    platformInternal: obj.platformInternal,
    iat: obj.iat,
    exp: obj.exp,
  });
}

function signPayload(payloadB64: string, key: string): string {
  const hmac = createHmac("sha256", key);
  hmac.update(payloadB64);
  return hmac.digest("hex");
}

function buildSignedContext(
  ctx: GateContext,
  key: string,
): { payload: string; signature: string } {
  const json = canonicalJson(ctx);
  const payload = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = signPayload(payload, key);
  return { payload, signature };
}

function mockReq(headers: Record<string, string> = {}, path = "/api/engagements/test-id/encumbrances"): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
    path,
    method: "GET",
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("gateContextVerification middleware", () => {
  const originalEnv = process.env;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("off mode (no signing key)", () => {
    it("passes through without verification", () => {
      delete process.env.GATE_CONTEXT_SIGNING_KEY;
      delete process.env.GATE_CONTEXT_MODE;

      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toBeUndefined();
    });

    it("ignores headers even if present", () => {
      delete process.env.GATE_CONTEXT_SIGNING_KEY;

      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toBeUndefined();
    });
  });

  describe("log mode (default with signing key)", () => {
    beforeEach(() => {
      process.env.GATE_CONTEXT_SIGNING_KEY = TEST_KEY;
      delete process.env.GATE_CONTEXT_MODE;
    });

    it("verifies valid context and sets req.gateContext", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: "key-123",
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
        "x-hauska-platform-internal": "false",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toEqual(ctx);
    });

    it("never rejects even with invalid signature", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload } = buildSignedContext(ctx, TEST_KEY);
      const badSig = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": badSig,
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("never rejects expired context", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec - 400,
        exp: nowSec - 100,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("never rejects malformed payload", () => {
      const req = mockReq({
        "x-hauska-gate-context": "not-valid-base64url!!!",
        "x-hauska-gate-signature": "deadbeef",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("never rejects missing headers", () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("detects mismatch between signed and plain headers but only warns (never rejects)", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "elgin_tx",
        "x-hauska-platform-internal": "false",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toEqual(ctx);
    });

    it("never rejects signed/plain mismatch in log mode (only warns)", () => {
      // Same forgery attack as enforce mode, but log mode only warns
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "elgin_tx",
        "x-hauska-platform-internal": "true",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      // Log mode: passes through despite mismatch
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toEqual(ctx);
    });
  });

  describe("enforce mode", () => {
    beforeEach(() => {
      process.env.GATE_CONTEXT_SIGNING_KEY = TEST_KEY;
      process.env.GATE_CONTEXT_MODE = "enforce";
    });

    it("verifies valid context", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toEqual(ctx);
    });

    it("rejects missing context with plain tenant headers (forged claim)", () => {
      const req = mockReq({
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "gate_context_required" });
    });

    it("allows missing context with no tenant headers (anonymous)", () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.gateContext).toBeUndefined();
    });

    it("rejects missing context with platform-internal header (forged claim)", () => {
      const req = mockReq({
        "x-hauska-platform-internal": "true",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "gate_context_required" });
    });

    it("rejects invalid signature with 401", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload } = buildSignedContext(ctx, TEST_KEY);
      const badSig = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": badSig,
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "gate_context_invalid",
        code: "SIGNATURE_INVALID",
      });
    });

    it("rejects expired context with 401", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec - 400,
        exp: nowSec - 100,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "gate_context_invalid",
        code: "EXPIRED",
      });
    });

    it("rejects malformed payload with 401", () => {
      const malformed = "not-valid-base64url!!!";
      const req = mockReq({
        "x-hauska-gate-context": malformed,
        "x-hauska-gate-signature": signPayload(malformed, TEST_KEY),
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "gate_context_invalid",
        code: "MALFORMED",
      });
    });

    it("rejects signed/plain mismatch (forgery attack) with 401", () => {
      // Attack: valid signed context for tenant A + plain headers claiming tenant B
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: false,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "elgin_tx",
        "x-hauska-platform-internal": "false",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "gate_context_mismatch" });
    });

    it("overwrites req.serviceAuth with verified context after successful verification", () => {
      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: true,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
        "x-hauska-platform-internal": "true",
      });

      // Simulate requireGateEngineServiceAuth having populated req.serviceAuth
      // with forged plain-header values before verifyGateContext runs
      req.serviceAuth = {
        tenantId: "00000000-0000-4000-8000-000000000001",
        jurisdictionTenant: "elgin_tx",
        platformInternal: false,
      };

      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      // Verified signed context overwrites the forged plain values
      expect(req.serviceAuth.jurisdictionTenant).toBe("bastrop_tx");
      expect(req.serviceAuth.platformInternal).toBe(true);
    });
  });

  describe("route scoping", () => {
    beforeEach(() => {
      process.env.GATE_CONTEXT_SIGNING_KEY = TEST_KEY;
      process.env.GATE_CONTEXT_MODE = "enforce";
    });

    it("scopes to gate-fronted routes (mount-relative form)", () => {
      // Routers are mounted inside /api parent, so req.path is mount-relative
      const gateFrontedPaths = [
        "/engagements/uuid/briefing",
        "/engagements/uuid/briefing/generate",
        "/engagements/uuid/briefing/status",
        "/engagements/uuid/briefing/runs",
        "/engagements/uuid/briefing/export.pdf",
        "/engagements/uuid/encumbrances",
        "/engagements/uuid/encumbrances/upload",
        "/engagements/uuid/site-topography",
        "/engagements/uuid/site-topography/refresh",
        "/engagements/uuid/site-drainage",
        "/engagements/uuid/site-drainage/design-storms",
        "/submissions/uuid/findings",
        "/submissions/uuid/findings/generate",
        "/findings/uuid/accept",
        "/findings/uuid/reject",
        "/findings/uuid/override",
        "/findings/uuid/outcome",
        "/findings/outcome-observations",
      ];

      for (const path of gateFrontedPaths) {
        const req = mockReq({
          "x-hauska-jurisdiction-tenant": "bastrop_tx",
        }, path);
        const res = mockRes();
        const next = vi.fn();

        verifyGateContext(req, res, next);

        expect(next, `path ${path} should be rejected`).not.toHaveBeenCalled();
        expect(res.status, `path ${path} should be rejected`).toHaveBeenCalledWith(401);
        vi.clearAllMocks();
      }
    });

    it("scopes to gate-fronted routes (absolute form with /api prefix)", () => {
      // Optional /api prefix branch for tests that construct absolute paths
      const req = mockReq({
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
      }, "/api/engagements/uuid/encumbrances");
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("does not scope to non-gate-fronted routes", () => {
      const nonGateFrontedPaths = [
        "/api/codes/jurisdictions",
        "/api/engagements",
        "/api/engagements/uuid",
        "/api/health",
        "/api/session",
      ];

      for (const path of nonGateFrontedPaths) {
        const req = mockReq({
          "x-hauska-jurisdiction-tenant": "bastrop_tx",
        }, path);
        const res = mockRes();
        const next = vi.fn();

        verifyGateContext(req, res, next);

        expect(next, `path ${path} should pass through`).toHaveBeenCalledOnce();
        expect(res.status, `path ${path} should not reject`).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }
    });
  });

  describe("resolveGateTenantContext behavior", () => {
    it("uses gateContext in enforce mode", () => {
      process.env.GATE_CONTEXT_SIGNING_KEY = TEST_KEY;
      process.env.GATE_CONTEXT_MODE = "enforce";

      const ctx: GateContext = {
        v: 1,
        tenant: "bastrop_tx",
        product: "architect",
        tier: "pro",
        keyId: null,
        platformInternal: true,
        iat: nowSec,
        exp: nowSec + 300,
      };
      const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

      const req = mockReq({
        "x-hauska-gate-context": payload,
        "x-hauska-gate-signature": signature,
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
        "x-hauska-platform-internal": "true",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.gateContext?.tenant).toBe("bastrop_tx");
      expect(req.gateContext?.platformInternal).toBe(true);
    });

    it("uses plain headers in log mode", () => {
      process.env.GATE_CONTEXT_SIGNING_KEY = TEST_KEY;
      delete process.env.GATE_CONTEXT_MODE;

      const req = mockReq({
        "x-hauska-jurisdiction-tenant": "bastrop_tx",
        "x-hauska-platform-internal": "true",
      });
      const res = mockRes();
      const next = vi.fn();

      verifyGateContext(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.gateContext).toBeUndefined();
    });
  });
});
