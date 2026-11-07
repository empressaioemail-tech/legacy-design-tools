/**
 * Browser-proxy end-user identity (hauska-map `api/spine.ts`).
 *
 * THE DEFECT THIS CLOSES. The hauska-map same-origin proxy used to attach
 * `SERVICE_API_KEY` to every `/api/spine/cortex/*` request from a browser and
 * forward no end-user identity. That key is the MCP / worker service
 * identity: `requireBrokerageAuthOrServiceToken` marks it
 * `brokerageServiceCaller`, and `resolveMapDataPackageTier` returns `max` for
 * it. So every anonymous visitor to smartsite.cloud was served as a Max
 * customer (map-data, the motivated-seller composite with owner mailing
 * addresses and homestead exemptions, every Max GIS layer).
 *
 * THE MODEL. The browser proxy gets its OWN credential,
 * `BROWSER_PROXY_API_KEYS` (comma-separated, for rotation). That credential
 * authenticates the TRANSPORT only — "this request came through the
 * smartsite.cloud proxy" — and is never a tier of record:
 *
 *   - `X-Hauska-End-User-Session: <cortex session token>` present and valid
 *     → the request runs AS THAT USER (same `req.session` and
 *     `brokerageAuth.tier = "user"` a direct `Authorization: Bearer <session>`
 *     call gets), so their own tier, unlocks and per-user metering apply.
 *   - header absent, expired, forged or anonymous → ANONYMOUS (public tier).
 *     DEFAULT DENY: there is no input that makes a proxy request a service
 *     or operator caller.
 *
 * The end-user credential is cortex's OWN signed session token (minted by
 * `/api/auth/session-exchange` and held in the hauska-map `pe_session`
 * HttpOnly cookie), re-verified here with SESSION_SECRET. The proxy never
 * asserts a user id or a tier; cortex reads both from its own token and DB.
 *
 * After classification the proxy key is REMOVED from the request headers, so
 * no downstream `SERVICE_API_KEY` comparison anywhere in the app can match it
 * even if an operator mis-sets the two to the same value.
 *
 * FORGERY. An end-user context header on a request that does NOT carry a
 * browser-proxy key is refused (401 `end_user_context_untrusted`): only the
 * proxy may speak for an end user this way. (A user calling cortex directly
 * still uses `Authorization: Bearer <their session>`, unchanged.)
 *
 * Service callers (smartsite-mcp, hauska-mcp-server, records-request-worker,
 * the command-center console) present `SERVICE_API_KEY` without this header
 * and are untouched by this middleware.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifySessionToken } from "../lib/sessionToken";
import { isAnonymousOwnerId } from "../lib/anonymousOwnerCookie";
import { logger } from "../lib/logger";
import { anonymousApplicantSession } from "./session";

export const END_USER_SESSION_HEADER = "x-hauska-end-user-session";
export const BROWSER_PROXY_KEYS_ENV = "BROWSER_PROXY_API_KEYS";

/** Identity claims stripped from every browser-proxy request (lowercase). */
export const PROXY_UNTRUSTED_IDENTITY_HEADERS = [
  "x-hauska-install-id",
  "x-pe-user-id",
  "x-hauska-jurisdiction-tenant",
  "x-hauska-platform-internal",
  "x-hauska-gate-context",
  "x-hauska-gate-signature",
] as const;

export type BrowserProxyEndUser =
  | { kind: "user"; userId: string }
  | { kind: "anonymous"; reason: "no_context" | "invalid_context" };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set when the request authenticated with a browser-proxy key. The
       * value is the END USER the request runs as — never a service caller.
       */
      browserProxyEndUser?: BrowserProxyEndUser;
    }
  }
}

let cachedKeys: string[] | null = null;
let warnedServiceCollision = false;

function loadBrowserProxyKeys(): string[] {
  if (cachedKeys) return cachedKeys;
  const raw = process.env[BROWSER_PROXY_KEYS_ENV]?.trim() ?? "";
  cachedKeys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return cachedKeys;
}

/** TEST-ONLY: re-read BROWSER_PROXY_API_KEYS after an env change. */
export function __resetBrowserProxyKeysForTests(): void {
  cachedKeys = null;
  warnedServiceCollision = false;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function isBrowserProxyKey(presented: string): boolean {
  let match = false;
  // Compare against every key (no early exit) so timing does not reveal
  // which rotation slot matched.
  for (const k of loadBrowserProxyKeys()) {
    if (timingSafeStringEqual(presented, k)) match = true;
  }
  return match;
}

function presentedKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer[ ]+(.+)$/i.exec(auth.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const hk = req.headers["x-hauska-key"];
  if (typeof hk === "string" && hk.trim()) return hk.trim();
  return null;
}

function endUserHeader(req: Request): string | null {
  const raw = req.headers[END_USER_SESSION_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Verified, non-anonymous user session carried by the proxy, or null. */
function verifyEndUserSession(token: string): ReturnType<typeof verifySessionToken> & { ok: true } | null {
  let verified: ReturnType<typeof verifySessionToken>;
  try {
    verified = verifySessionToken(token);
  } catch {
    return null;
  }
  if (!verified.ok) return null;
  const r = verified.session.requestor;
  if (r?.kind !== "user" || !r.id.trim() || isAnonymousOwnerId(r.id)) return null;
  // Only end-user audiences. An internal-audience token is an operator
  // console credential and must never be relayed through the public proxy.
  if (verified.session.audience === "internal") return null;
  return verified;
}

export function isBrowserProxyCaller(req: Request): boolean {
  return req.browserProxyEndUser !== undefined;
}

export const browserProxyEndUserMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const claim = endUserHeader(req);
  const presented = presentedKey(req);
  const viaProxy = presented !== null && isBrowserProxyKey(presented);

  if (!viaProxy) {
    if (claim !== null) {
      res.status(401).json({
        error: "end_user_context_untrusted",
        message:
          "X-Hauska-End-User-Session is accepted only from the browser proxy.",
      });
      return;
    }
    next();
    return;
  }

  if (!warnedServiceCollision) {
    const svc = process.env["SERVICE_API_KEY"]?.trim();
    if (svc && isBrowserProxyKey(svc)) {
      warnedServiceCollision = true;
      logger.error(
        { env: BROWSER_PROXY_KEYS_ENV },
        "a browser-proxy key equals SERVICE_API_KEY; the request is treated as the browser proxy (end-user tier), never as the service. Rotate one of them.",
      );
    }
  }

  // Transport authenticated. Strip the proxy credential so no service-key
  // comparison downstream can ever match it.
  delete req.headers.authorization;
  delete req.headers["x-hauska-key"];
  delete req.headers[END_USER_SESSION_HEADER];
  // The verified end-user session is the ONLY identity a proxy request may
  // carry. Every other identity-bearing header is a browser-supplied,
  // unverifiable claim on this path: an install id (install-scoped Max /
  // BROKERAGE_MAP_DATA_MAX_INSTALL_IDS), the service-impersonation user id,
  // and the gate tenant / platform-internal headers.
  for (const h of PROXY_UNTRUSTED_IDENTITY_HEADERS) delete req.headers[h];

  const verified = claim !== null ? verifyEndUserSession(claim) : null;
  if (verified) {
    req.session = verified.session;
    // T1-A: the revocation middleware checks this token server-side next.
    req.peSessionToken = claim!;
    req.brokerageAuth = { tier: "user" };
    req.browserProxyEndUser = {
      kind: "user",
      userId: verified.session.requestor!.id,
    };
  } else {
    // Anonymous: drop anything that could read as an identified user.
    req.session = anonymousApplicantSession();
    req.peSessionToken = undefined;
    req.brokerageAuth = undefined;
    req.browserProxyEndUser = {
      kind: "anonymous",
      reason: claim === null ? "no_context" : "invalid_context",
    };
  }
  next();
};
