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

function mockReq(headers: Record<string, string> = {}): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
    path: "/test/path",
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

    it("detects mismatch between signed and plain headers", () => {
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

    it("rejects missing headers with 401", () => {
      const req = mockReq();
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
      const req = mockReq({
        "x-hauska-gate-context": "not-valid-base64url!!!",
        "x-hauska-gate-signature": "deadbeef",
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
  });
});
