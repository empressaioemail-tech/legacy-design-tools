/**
 * Dual-path auth for brokerage Layer 2 routes called by hauska-mcp-server.
 *
 * Accepts EITHER:
 *   - `Authorization: Bearer <SERVICE_API_KEY>` — MCP service caller
 *     (no install id; wallet paywall skipped; metering signal surfaced)
 *   - Brokerage extension keys (`BROKERAGE_DEV_API_KEY`, etc.) — existing
 *     Chrome extension / pilot path via {@link brokerageAuth}
 *
 * cc-agent-M's `legacy-client.ts` sends the same bearer token as the L-surface
 * routes (`SERVICE_API_KEY` / `LEGACY_BACKEND_API_KEY`).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_TENANT_ID } from "./session";
import {
  brokerageAuth,
  extractBrokerageApiKey,
  loadBrokerageApiKeys,
  resolveBrokerageClientTier,
} from "./brokerageAuth";
import { getServiceApiKey } from "../lib/serviceToken";

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
      req.serviceAuth = { tenantId: DEFAULT_TENANT_ID };
      req.brokerageServiceCaller = true;
      next();
      return;
    }

    const keys = loadBrokerageApiKeys();
    if (keys.size === 0) {
      res.status(503).json({
        error: "property_brief_api_unconfigured",
        message: "Property Brief API key is not configured on this server",
      });
      return;
    }

    if (keys.has(provided)) {
      req.brokerageAuth = { tier: resolveBrokerageClientTier(provided) };
      next();
      return;
    }

    res.status(401).json({
      error: "unauthorized",
      message:
        "Valid Authorization Bearer (service token or brokerage key) or X-Hauska-Key required",
    });
    return;
  }

  brokerageAuth(req, res, next);
};
