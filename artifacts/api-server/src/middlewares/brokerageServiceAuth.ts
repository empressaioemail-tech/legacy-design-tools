/**
 * Dual-path auth for brokerage Layer 2 routes called by hauska-mcp-server.
 *
 * Accepts EITHER:
 *   - `Authorization: Bearer <SERVICE_API_KEY>` — MCP service caller
 *     (no install id; wallet paywall skipped; metering signal surfaced)
 *   - Brokerage operator keys (`BROKERAGE_OPERATOR_API_KEYS`,
 *     `BROKERAGE_API_KEYS`) via {@link brokerageAuth}. The chrome-extension
 *     key (`BROKERAGE_EXTENSION_PUBLIC_KEY`) is retired (2026-09-07) and is
 *     never a recognized key — see brokerageAuth.ts.
 *
 * cc-agent-M's `legacy-client.ts` sends the same bearer token as the L-surface
 * routes (`SERVICE_API_KEY` / `LEGACY_BACKEND_API_KEY`).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  brokerageAuth,
  extractBrokerageApiKey,
  loadBrokerageApiKeys,
  resolveBrokerageClientTier,
} from "./brokerageAuth";
import { getServiceApiKey } from "../lib/serviceToken";
import { buildGateServiceAuth } from "../lib/gateFrontSeam";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set when the request authenticated with `SERVICE_API_KEY` on a
       * brokerage route. Wallet paywall and install-id requirements are
       * skipped; the MCP gate owns metering.
       */
      brokerageServiceCaller?: true;
    }
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function isBrokerageServiceCaller(req: Request): boolean {
  return req.brokerageServiceCaller === true;
}

export const requireBrokerageAuthOrServiceToken: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const provided = extractBrokerageApiKey(req);

  if (provided) {
    if (timingSafeStringEqual(provided, getServiceApiKey())) {
      req.serviceAuth = buildGateServiceAuth(req);
      req.brokerageServiceCaller = true;
      next();
      return;
    }

    const keys = loadBrokerageApiKeys();
    if (keys.has(provided)) {
      req.brokerageAuth = { tier: resolveBrokerageClientTier(provided) };
      next();
      return;
    }

    // Session JWT bearer or any other brokerageAuth path — do not hard-401
    // (or hard-503 on an empty key set) before brokerageAuth can classify;
    // it checks the session-JWT path before the keys-configured gate.
    brokerageAuth(req, res, next);
    return;
  }

  brokerageAuth(req, res, next);
};

/** Skip extension brokerage key check when the MCP service path already authenticated. */
export const requireBrokerageExtensionAuthUnlessService: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (isBrokerageServiceCaller(req)) {
    next();
    return;
  }
  brokerageAuth(req, res, next);
};
