/**
 * Gate context verification middleware (Tenancy T1 consumer side).
 *
 * Verifies the HMAC-signed tenant context from the Hauska MCP gate.
 * Three modes via GATE_CONTEXT_MODE env:
 *   - `off` (default when GATE_CONTEXT_SIGNING_KEY unset): no verification,
 *     byte-identical to pre-T1 behavior
 *   - `log` (default when GATE_CONTEXT_SIGNING_KEY set): verify and emit
 *     structured logs; NEVER reject requests (build-and-stage default)
 *   - `enforce`: 401 on forged tenant claims (signed context absent but
 *     plain tenant-claiming headers present); allow anonymous requests
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

/**
 * Route patterns for the six gate-fronted routers. The middleware only
 * enforces verification on these routes; other routes pass through
 * without triggering gate_context_missing logs.
 *
 * Patterns use optional `/api` prefix because routers are mounted inside
 * `/api` parent router, so `req.path` is mount-relative at runtime.
 */
const GATE_FRONTED_ROUTE_PATTERNS = [
  /^(?:\/api)?\/engagements\/[^/]+\/briefing(?:\/|$)/,
  /^(?:\/api)?\/engagements\/[^/]+\/encumbrances(?:\/|$)/,
  /^(?:\/api)?\/engagements\/[^/]+\/site-drainage(?:\/|$)/,
  /^(?:\/api)?\/engagements\/[^/]+\/site-topography(?:\/|$)/,
  /^(?:\/api)?\/findings\/[^/]+\/(accept|reject|override|outcome)(?:\/|$)/,
  /^(?:\/api)?\/findings\/outcome-observations(?:\/|$)/,
  /^(?:\/api)?\/submissions\/[^/]+\/findings(?:\/|$)/,
];

function isGateFrontedRoute(path: string): boolean {
  return GATE_FRONTED_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

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

/**
 * Check if a request carries plain tenant-claiming headers (the forgery
 * vector T1 closes). Returns true when EITHER plain header is present
 * and non-empty.
 */
function hasPlainTenantClaims(req: Request): boolean {
  const tenant = readGateJurisdictionTenant(req);
  const platformInternal = readGatePlatformInternal(req);
  return tenant !== null || platformInternal;
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

  // Scope the middleware: only gate-fronted routes trigger verification
  if (!isGateFrontedRoute(req.path)) {
    next();
    return;
  }

  const payloadB64 = req.header(GATE_CONTEXT_HEADER);
  const signature = req.header(GATE_SIGNATURE_HEADER);

  if (!payloadB64 || !signature) {
    // Enforce semantics: reject forged tenant claims only
    if (mode === "enforce" && hasPlainTenantClaims(req)) {
      logger.warn({
        event: "gate_context_required",
        path: req.path,
        method: req.method,
        reason: "plain_tenant_headers_without_signature",
      });
      res.status(401).json({ error: "gate_context_required" });
      return;
    }

    // Log mode OR enforce mode with no tenant claims → allow through
    logger.info({
      event: "gate_context_missing",
      path: req.path,
      method: req.method,
      mode,
      hasPlainTenantClaims: hasPlainTenantClaims(req),
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

      // Enforce mode: reject forged plain headers (Finding 4)
      if (mode === "enforce") {
        res.status(401).json({ error: "gate_context_mismatch" });
        return;
      }
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

    // Overwrite req.serviceAuth with verified context in enforce mode to
    // prevent downstream handlers from reading forged plain-header values
    // (Finding 4)
    if (mode === "enforce" && req.serviceAuth) {
      req.serviceAuth.jurisdictionTenant = ctx.tenant;
      req.serviceAuth.platformInternal = ctx.platformInternal;
    }

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
