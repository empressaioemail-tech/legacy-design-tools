/**
 * T1-A (2026-10-22) — server-side session check for every request that
 * carries a signed session token.
 *
 * `sessionMiddleware` and `browserProxyEndUserMiddleware` verify a token's
 * HMAC and `exp` synchronously and record it on `req.peSessionToken`. This
 * middleware, mounted right after them, asks the database whether that token
 * is still live (`peSessions.ts`: not revoked by logout, not past its sliding
 * expiry, not cut off by account delete or an account merge). A dead token
 * demotes the request to the anonymous applicant, so every gated route
 * answers exactly as it would for a signed-out caller.
 *
 * Fail-open on a DATABASE ERROR only (logged): the token's own signature and
 * `exp` were already verified, and treating every signed-in user as anonymous
 * during a database blip would not protect anything the blip has not already
 * taken down. A token the database positively reports dead is never honored.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { checkSessionTokenLive } from "../lib/peSessions";
import { logger } from "../lib/logger";
import { ensureUserProfile } from "../lib/userProfiles";
import { shouldEnsureUserProfile } from "../lib/engagementOwnership";
import { anonymousApplicantSession } from "./session";

function backfillProfile(req: Request): void {
  const r = req.session.requestor;
  if (r && r.kind === "user" && shouldEnsureUserProfile(r.id)) {
    void ensureUserProfile(r.id);
  }
}

export const sessionRevocationMiddleware: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = req.peSessionToken;
  if (!token || req.session.requestor?.kind !== "user") {
    next();
    return;
  }
  let live: boolean;
  try {
    live = (await checkSessionTokenLive(token)).live;
  } catch (err) {
    logger.warn({ err }, "session revocation check failed; honoring the verified token");
    live = true;
  }
  if (live) {
    backfillProfile(req);
    next();
    return;
  }
  req.session = anonymousApplicantSession();
  req.peSessionToken = undefined;
  if (req.browserProxyEndUser) {
    req.browserProxyEndUser = { kind: "anonymous", reason: "invalid_context" };
    req.brokerageAuth = undefined;
  }
  next();
};
