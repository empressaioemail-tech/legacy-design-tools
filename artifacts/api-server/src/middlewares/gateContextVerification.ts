/**
 * Gate context verification middleware (Tenancy T1 consumer side).
 *
 * Verifies the HMAC-signed tenant context from the Hauska MCP gate.
 * Three modes via GATE_CONTEXT_MODE env:
 *   - `off` (default when GATE_CONTEXT_SIGNING_KEY unset): no verification,
 *     byte-identical to pre-T1 behavior
 *   - `log` (default when GATE_CONTEXT_SIGNING_KEY set): verify and emit
 *     structured logs; NEVER reject requests (build-and-stage default)
 *   - `enforce`: 401 on missing/invalid gate context
 *
 * The prod flip from log→enforce is explicitly operator-gated; nothing
 * built here may change current prod behavior by default.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  verifySignedGateContext,
  GateContextVerificationError,
  type GateContext,
} from "../lib/gateContextVerify";
import { logger } from "../lib/logger";
import {
  readGateJurisdictionTenant,
  readGatePlatformInternal,
} from "../lib/gateFrontSeam";

const GATE_CONTEXT_HEADER = "x-hauska-gate-context";
const GATE_SIGNATURE_HEADER = "x-hauska-gate-signature";

type GateContextMode = "off" | "log" | "enforce";

function getGateContextMode(): GateContextMode {
  const key = process.env.GATE_CONTEXT_SIGNING_KEY;
  if (!key) return "off";

  const mode = process.env.GATE_CONTEXT_MODE?.trim().toLowerCase();
  if (mode === "enforce") return "enforce";
  return "log";
}

function getSigningKey(): string | null {
  return process.env.GATE_CONTEXT_SIGNING_KEY?.trim() || null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      gateContext?: GateContext;
    }
  }
}

export const verifyGateContext: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const mode = getGateContextMode();

  if (mode === "off") {
    next();
    return;
  }

  const key = getSigningKey();
  if (!key) {
    next();
    return;
  }

  const payloadB64 = req.header(GATE_CONTEXT_HEADER);
  const signature = req.header(GATE_SIGNATURE_HEADER);

  if (!payloadB64 || !signature) {
    if (mode === "enforce") {
      logger.info({
        event: "gate_context_missing",
        path: req.path,
        method: req.method,
      });
      res.status(401).json({ error: "gate_context_required" });
      return;
    }

    logger.info({
      event: "gate_context_missing",
      path: req.path,
      method: req.method,
      mode,
    });
    next();
    return;
  }

  try {
    const nowMs = Date.now();
    const ctx = verifySignedGateContext(payloadB64, signature, key, nowMs);

    const plainTenant = readGateJurisdictionTenant(req);
    const plainPlatformInternal = readGatePlatformInternal(req);

    const mismatch =
      ctx.tenant !== plainTenant ||
      ctx.platformInternal !== plainPlatformInternal;

    if (mismatch) {
      logger.warn({
        event: "gate_context_mismatch",
        path: req.path,
        method: req.method,
        signedTenant: ctx.tenant,
        plainTenant,
        signedPlatformInternal: ctx.platformInternal,
        plainPlatformInternal,
      });
    } else {
      logger.info({
        event: "gate_context_verified",
        path: req.path,
        method: req.method,
        tenant: ctx.tenant,
        product: ctx.product,
        tier: ctx.tier,
        platformInternal: ctx.platformInternal,
      });
    }

    req.gateContext = ctx;
    next();
  } catch (err) {
    if (err instanceof GateContextVerificationError) {
      logger.warn({
        event: "gate_context_invalid",
        path: req.path,
        method: req.method,
        code: err.code,
        message: err.message,
      });

      if (mode === "enforce") {
        res.status(401).json({ error: "gate_context_invalid", code: err.code });
        return;
      }

      next();
      return;
    }

    logger.error({
      event: "gate_context_verification_error",
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
    });

    if (mode === "enforce") {
      res.status(500).json({ error: "internal_server_error" });
      return;
    }

    next();
  }
};
