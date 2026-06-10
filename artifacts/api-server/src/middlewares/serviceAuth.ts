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
import { buildGateServiceAuth } from "../lib/gateFrontSeam";

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
  req.serviceAuth = buildGateServiceAuth(req);
  next();
};

/**
 * Dual-path auth for the L-surface (L1-L6) routes — accepts EITHER a
 * service token OR a browser session.
 *
 * Why dual-path: the L-surface endpoints have two co-consumers. cc-agent-M's
 * hauska-mcp-server calls them service-to-service with
 * `Authorization: Bearer <token>` (the {@link requireServiceToken} path).
 * The Cortex SPAs (design-tools architect surface, plan-review reviewer
 * surface) call the same endpoints from the browser, where a session
 * cookie — not the service secret — is the only credential available.
 * A browser cannot carry the service token, so a bearer-only gate would
 * lock the UI out of its own endpoints.
 *
 * Behavior:
 *   - `Authorization: Bearer` present → it MUST be valid. Valid →
 *     {@link Request.serviceAuth} is attached and `next()` runs; invalid
 *     → `401 { error: "unauthorized" }`. A present-but-wrong token is a
 *     misconfigured service caller, not a browser, so it fails loudly
 *     rather than silently falling through to the session path.
 *   - No `Authorization` header → the browser-session path. `next()`
 *     runs; the route handler reads `req.session` (always populated by
 *     `sessionMiddleware`).
 *
 * Audience note (surfaced to the planner in the C.4.1 PR): the Lane C.4
 * dispatch asked that the session path be gated on "the right audience".
 * In this codebase the design-tools architect SPA carries
 * `audience: "user"` — which is byte-identical to the anonymous-applicant
 * default `sessionMiddleware` hands every request. There is no audience
 * value that distinguishes an authenticated architect from an anonymous
 * caller, so audience-gating the session path is not meaningful for the
 * architect surfaces (L1/L3/L4/L5/L6). The session path therefore matches
 * the posture of every other architect-facing route (`/engagements/*`,
 * `/snapshots/*`): open to any browser request. In production
 * `sessionMiddleware` is fail-closed — every request is the anonymous
 * applicant — so the L-routes inherit the same fail-closed prod posture
 * as every existing reviewer feature, pending the real-auth layer
 * (task #29). This is not a C.4 blocker; it is stated here and in the
 * PR so the posture is explicit.
 */
export const requireServiceTokenOrSession: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const header = req.header("authorization");
  if (header) {
    const presented = extractBearerToken(req);
    if (
      presented === null ||
      !timingSafeStringEqual(presented, getServiceApiKey())
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.serviceAuth = buildGateServiceAuth(req);
    next();
    return;
  }
  // No Authorization header — the browser-session path. `req.session`
  // is always populated by `sessionMiddleware`; the route reads it.
  next();
};
