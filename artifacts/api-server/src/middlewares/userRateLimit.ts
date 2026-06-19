import type { RequestHandler, Request, Response } from "express";
import {
  assertUserApiRateAllowed,
} from "../lib/userMetering";
import { sessionOwnerUserId } from "../lib/engagementOwnership";
import { isAnonymousOwnerId } from "../lib/anonymousOwnerCookie";

/** Paths that must never be blocked by per-user API metering. */
export function isUserRateLimitExemptPath(path: string): boolean {
  if (
    path === "/api/healthz" ||
    path === "/api/health" ||
    path === "/healthz" ||
    path === "/health"
  ) {
    return true;
  }
  if (path === "/api/brokerage/v1/billing/stripe/webhook") {
    return true;
  }
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return true;
  }
  return false;
}

/**
 * Per-user daily API rate limit for authenticated Cortex web sessions.
 * Anonymous and internal sessions pass through (extension has its own limits).
 */
export const userRateLimitMiddleware: RequestHandler = async (
  req: Request,
  res: Response,
  next,
) => {
  if (isUserRateLimitExemptPath(req.path)) {
    next();
    return;
  }
  if (req.session.audience === "internal") {
    next();
    return;
  }
  const ownerId = sessionOwnerUserId(req.session);
  if (!ownerId || isAnonymousOwnerId(ownerId)) {
    next();
    return;
  }
  try {
    const result = await assertUserApiRateAllowed(ownerId);
    if (!result.ok) {
      res.status(429).json({
        error: result.error,
        limit: result.limit,
        used: result.used,
      });
      return;
    }
    res.setHeader("X-Hauska-RateLimit-Limit", String(result.limit));
    res.setHeader("X-Hauska-RateLimit-Used", String(result.used));
    next();
  } catch (err) {
    next(err);
  }
};
