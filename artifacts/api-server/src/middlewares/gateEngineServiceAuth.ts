/**
 * Dual-path auth for gate-front engine entry points (tenant leg step 2).
 *
 * Accepts EITHER:
 *   - `Authorization: Bearer <SERVICE_API_KEY>` — MCP gate (sets
 *     {@link Request.serviceAuth} with forwarded jurisdiction tenant)
 *   - No Authorization header — browser session path (architect / reviewer UI)
 *
 * Mirrors {@link requireServiceTokenOrSession} but is scoped to the
 * property/parcel and plan-review engine routes named in ADR-008.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getServiceApiKey } from "../lib/serviceToken";
import { buildGateServiceAuth } from "../lib/gateFrontSeam";

function extractBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export const requireGateEngineServiceAuth: RequestHandler = (
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
  next();
};
