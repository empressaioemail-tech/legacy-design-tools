/**
 * Service-token bearer-auth middleware for the Cortex L-surface
 * (L1-L6) endpoints.
 *
 * cc-agent-M's hauska-mcp-server (`legacy-client.ts`) flagged this as a
 * Lane C coordination item: the L-surface MCP tools call legacy-design-
 * tools endpoints with `Authorization: Bearer <token>` and the legacy
 * backend needs a middleware to validate it. The canonical contract
 * (doc_repo `_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`)
 * specifies every L-route as bearer-auth, service-token, tenant-scoped.
 *
 * Tenant resolution: legacy-design-tools is single-tenant today — there
 * are no `tenant_id` columns on engagements / submissions, and the
 * session middleware resolves every request to {@link DEFAULT_TENANT_ID}.
 * The bearer key therefore resolves to that single default tenant.
 * `req.serviceAuth.tenantId` is carried explicitly so the L-route
 * handlers read tenant the same way regardless of how multi-tenancy
 * later lands.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getServiceApiKey } from "../lib/serviceToken";
import { DEFAULT_TENANT_ID } from "./session";

// Augment Express's Request so L-route handlers can read
// `req.serviceAuth` without a per-call cast. Uses the global `Express`
// namespace (the same approach `session.ts` takes) so no direct
// dependency on `express-serve-static-core` types is needed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by {@link requireServiceToken} once a request presents a
       * valid `Authorization: Bearer` service token. Absent on requests
       * that have not passed service-token auth.
       */
      serviceAuth?: { tenantId: string };
    }
  }
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
function extractBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Length-independent constant-time string compare. Both inputs are
 * sha256-hashed first so the digests are always equal length (a bare
 * `timingSafeEqual` throws on length mismatch and a length pre-check
 * would itself leak the secret's length).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Express middleware: require a valid `Authorization: Bearer` service
 * token. On success attaches {@link Request.serviceAuth} and calls
 * `next()`. A missing, malformed, or wrong token responds
 * `401 { error: "unauthorized" }` — the same envelope shape the
 * L-surface contract uses for its 4xx bodies.
 */
export const requireServiceToken: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const presented = extractBearerToken(req);
  if (presented === null) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!timingSafeStringEqual(presented, getServiceApiKey())) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.serviceAuth = { tenantId: DEFAULT_TENANT_ID };
  next();
};
