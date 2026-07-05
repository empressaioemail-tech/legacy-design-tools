/**
 * Gate context verification (Tenancy T1 consumer side).
 *
 * Verifies signed tenant contexts from the Hauska MCP gate. The gate is
 * the single trusted tenant resolver; this module verifies its
 * HMAC-SHA256-signed contexts so cortex-api can trust the tenant identity
 * without blind-trust forwarded headers.
 *
 * Wire contract (must match hauska-mcp-server PR #37 producer exactly):
 *   X-Hauska-Gate-Context: <base64url-encoded JSON payload>
 *   X-Hauska-Gate-Signature: <hex-encoded HMAC-SHA256 signature>
 *
 * The signature is computed over the base64url payload using
 * GATE_CONTEXT_SIGNING_KEY (HMAC-SHA256). Contexts expire 300s after
 * issuance (iat + 300s). Verification uses constant-time comparison.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface GateContext {
  v: 1;
  tenant: string | null;
  product: string;
  tier: string;
  keyId: string | null;
  platformInternal: boolean;
  iat: number;
  exp: number;
}

export class GateContextVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GateContextVerificationError";
  }
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "==".slice(0, (4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function signPayload(payloadB64: string, key: string): string {
  const hmac = createHmac("sha256", key);
  hmac.update(payloadB64);
  return hmac.digest("hex");
}

export function verifySignedGateContext(
  payloadB64: string,
  signature: string,
  key: string,
  nowMs: number,
): GateContext {
  const expectedSig = signPayload(payloadB64, key);

  // Constant-time signature comparison. Both signatures are hex-encoded
  // HMAC-SHA256 outputs (64 hex chars = 32 bytes). Convert to buffers
  // and use timingSafeEqual.
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (sigBuf.length !== expectedBuf.length) {
    throw new GateContextVerificationError(
      "Signature length mismatch",
      "SIGNATURE_INVALID",
    );
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    throw new GateContextVerificationError(
      "Signature verification failed",
      "SIGNATURE_INVALID",
    );
  }

  let json: string;
  try {
    json = base64urlDecode(payloadB64).toString("utf8");
  } catch {
    throw new GateContextVerificationError(
      "Invalid base64url payload",
      "MALFORMED",
    );
  }

  let ctx: unknown;
  try {
    ctx = JSON.parse(json);
  } catch {
    throw new GateContextVerificationError(
      "Payload is not valid JSON",
      "MALFORMED",
    );
  }

  if (typeof ctx !== "object" || ctx === null) {
    throw new GateContextVerificationError(
      "Payload is not a JSON object",
      "MALFORMED",
    );
  }

  const obj = ctx as Record<string, unknown>;

  if (obj.v !== 1) {
    throw new GateContextVerificationError(
      "Unsupported context version",
      "MALFORMED",
    );
  }

  if (typeof obj.iat !== "number" || typeof obj.exp !== "number") {
    throw new GateContextVerificationError(
      "Missing or invalid iat/exp timestamps",
      "MALFORMED",
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= obj.exp) {
    throw new GateContextVerificationError(
      `Context expired at ${obj.exp}, now is ${nowSec}`,
      "EXPIRED",
    );
  }

  // Type-check remaining fields. tenant and keyId can be null; the rest
  // are required strings or boolean.
  if (
    (obj.tenant !== null && typeof obj.tenant !== "string") ||
    typeof obj.product !== "string" ||
    typeof obj.tier !== "string" ||
    (obj.keyId !== null && typeof obj.keyId !== "string") ||
    typeof obj.platformInternal !== "boolean"
  ) {
    throw new GateContextVerificationError(
      "Payload field type mismatch",
      "MALFORMED",
    );
  }

  return obj as unknown as GateContext;
}
