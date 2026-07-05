import { describe, expect, it } from "vitest";
import {
  verifySignedGateContext,
  GateContextVerificationError,
  type GateContext,
} from "../gateContextVerify";
import { createHmac } from "node:crypto";

const TEST_KEY = "test-signing-key-for-gate-context";

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

describe("gateContextVerify", () => {
  const nowMs = 1700000000000;
  const nowSec = Math.floor(nowMs / 1000);

  it("verifies valid signed context", () => {
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

    const verified = verifySignedGateContext(
      payload,
      signature,
      TEST_KEY,
      nowMs,
    );
    expect(verified).toEqual(ctx);
  });

  it("verifies context with null tenant and keyId", () => {
    const ctx: GateContext = {
      v: 1,
      tenant: null,
      product: "architect",
      tier: "free",
      keyId: null,
      platformInternal: true,
      iat: nowSec,
      exp: nowSec + 300,
    };
    const { payload, signature } = buildSignedContext(ctx, TEST_KEY);

    const verified = verifySignedGateContext(
      payload,
      signature,
      TEST_KEY,
      nowMs,
    );
    expect(verified).toEqual(ctx);
  });

  it("rejects tampered signature", () => {
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
    const tamperedSig = signature.slice(0, -4) + "dead";

    expect(() =>
      verifySignedGateContext(payload, tamperedSig, TEST_KEY, nowMs),
    ).toThrow(GateContextVerificationError);

    try {
      verifySignedGateContext(payload, tamperedSig, TEST_KEY, nowMs);
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe(
        "SIGNATURE_INVALID",
      );
    }
  });

  it("rejects wrong signing key", () => {
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

    expect(() =>
      verifySignedGateContext(payload, signature, "wrong-key", nowMs),
    ).toThrow(GateContextVerificationError);
  });

  it("rejects expired context", () => {
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

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("EXPIRED");
    }
  });

  it("rejects malformed base64url payload", () => {
    const payload = "not-valid-base64url!!!";
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("rejects non-JSON payload", () => {
    const payload = base64urlEncode(Buffer.from("not json", "utf8"));
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("rejects non-object JSON payload", () => {
    const payload = base64urlEncode(Buffer.from(JSON.stringify([1, 2, 3]), "utf8"));
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("rejects unsupported version", () => {
    const ctx = {
      v: 2,
      tenant: "bastrop_tx",
      product: "architect",
      tier: "pro",
      keyId: null,
      platformInternal: false,
      iat: nowSec,
      exp: nowSec + 300,
    };
    const json = JSON.stringify(ctx);
    const payload = base64urlEncode(Buffer.from(json, "utf8"));
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("rejects missing timestamps", () => {
    const ctx = {
      v: 1,
      tenant: "bastrop_tx",
      product: "architect",
      tier: "pro",
      keyId: null,
      platformInternal: false,
    };
    const json = JSON.stringify(ctx);
    const payload = base64urlEncode(Buffer.from(json, "utf8"));
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("rejects invalid field types", () => {
    const ctx = {
      v: 1,
      tenant: 123,
      product: "architect",
      tier: "pro",
      keyId: null,
      platformInternal: false,
      iat: nowSec,
      exp: nowSec + 300,
    };
    const json = JSON.stringify(ctx);
    const payload = base64urlEncode(Buffer.from(json, "utf8"));
    const signature = signPayload(payload, TEST_KEY);

    try {
      verifySignedGateContext(payload, signature, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe("MALFORMED");
    }
  });

  it("constant-time comparison catches length mismatch", () => {
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
    const shortSig = "deadbeef";

    try {
      verifySignedGateContext(payload, shortSig, TEST_KEY, nowMs);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GateContextVerificationError);
      expect((err as GateContextVerificationError).code).toBe(
        "SIGNATURE_INVALID",
      );
    }
  });
});
