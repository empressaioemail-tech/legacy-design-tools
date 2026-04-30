/**
 * Session middleware — single source of truth for "who is making this
 * request" inside api-server.
 *
 * Today there is no real auth layer in this project; this middleware is
 * the integration point where signed-cookie / JWT verification will live
 * once it lands (Spec 20 follow-up, task #29). Until then the middleware
 * is **fail-closed in production**: the audience, requestor, and
 * permission claims from any client-supplied cookie are ignored, and
 * every production request is treated as the least-privilege anonymous
 * applicant (`audience: "user"`).
 *
 * Why fail closed in prod?
 * ------------------------
 * The previous chat route trusted an `x-audience` header that any
 * applicant could spoof to obtain internal-only Revit binding details.
 * Replacing that with an *unsigned* `pr_session` cookie would not fix
 * the problem — a cookie is just another client-controlled field. So
 * until a real auth layer mints a *verified* session token (signed
 * cookie, JWT, OAuth, …) we refuse to elevate any production request
 * above the applicant baseline. The only safe production change is
 * downward (an authenticated check could *narrow* permissions, but
 * never widen them).
 *
 * Dev / test posture
 * ------------------
 * Outside production (`NODE_ENV !== "production"`) the middleware
 * accepts two un-verified inputs as a developer / test convenience:
 *   - a `pr_session` JSON cookie (see "Wire format" below); and
 *   - the override headers `x-audience` / `x-requestor` / `x-permissions`.
 * Both paths are stripped at the door under `NODE_ENV === "production"`
 * so a deployed server cannot be coerced via either route. Tests opt
 * into a specific audience by either path; route handlers stay
 * blissfully unaware of which one was used.
 *
 * Wire format (dev / test only)
 * -----------------------------
 * Cookie name: `pr_session`
 * Cookie value: JSON object of shape {@link SessionUser}, e.g.
 *   `{"audience":"internal","requestor":{"kind":"user","id":"u1"}}`
 * Unknown fields are ignored. Decode errors fall back to the anonymous
 * applicant default (we never 500 a request because of a malformed
 * cookie — the user can simply re-login).
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "../lib/logger";

/**
 * Identity attached to every request after this middleware runs. The
 * shape is the smallest superset of {@link Scope} fields the chat route
 * actually consumes today — `audience`, optional `requestor`, optional
 * `permissions`. Routes should treat `req.session` as read-only and pull
 * exactly the fields they need into a fresh `Scope` object.
 */
export interface SessionUser {
  audience: "internal" | "user" | "ai";
  requestor?: { kind: "user" | "agent"; id: string };
  permissions?: ReadonlyArray<string>;
}

// Augment Express's global Request shape so route handlers can read
// `req.session` without a per-call cast. Using the global `Express`
// namespace (rather than `declare module "express-serve-static-core"`)
// avoids needing a direct dependency on the serve-static-core types
// package — Express's own type definitions extend the same namespace.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Session attached by {@link sessionMiddleware}. Always present
       * once the middleware has run — anonymous requests get the
       * least-privilege applicant default rather than `undefined`, so
       * routes never have to null-check.
       */
      session: SessionUser;
    }
  }
}

/** Cookie name carrying the JSON-encoded session payload. */
export const SESSION_COOKIE = "pr_session";

/**
 * The default session for requests that did not present a `pr_session`
 * cookie. Locked to applicant audience so an unauthenticated caller can
 * never see internal-only fields (Revit binding, etc.).
 */
const ANONYMOUS_APPLICANT: SessionUser = Object.freeze({ audience: "user" });

/**
 * Decode the `pr_session` cookie body. Returns `null` for missing /
 * malformed cookies so the caller can fall back to the anonymous default.
 *
 * The format is intentionally loose — unknown keys are dropped, and
 * type-mismatched values cause the whole cookie to be discarded rather
 * than producing a partially-populated session. Once real auth lands
 * this function will be replaced by signed-cookie / JWT verification;
 * the parse-or-null contract stays the same.
 */
function parseSessionCookie(raw: unknown): SessionUser | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const audience = obj["audience"];
  if (audience !== "internal" && audience !== "user" && audience !== "ai") {
    return null;
  }
  const session: SessionUser = { audience };

  const requestor = obj["requestor"];
  if (requestor && typeof requestor === "object") {
    const r = requestor as Record<string, unknown>;
    const kind = r["kind"];
    const id = r["id"];
    if ((kind === "user" || kind === "agent") && typeof id === "string" && id) {
      session.requestor = { kind, id };
    }
  }

  const permissions = obj["permissions"];
  if (Array.isArray(permissions)) {
    const filtered = permissions.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    if (filtered.length > 0) session.permissions = filtered;
  }

  return session;
}

/**
 * Apply the dev-only header overrides on top of a session. No-op in
 * production. Recognized headers:
 *
 *   - `x-audience`           — `"internal" | "user" | "ai"`
 *   - `x-requestor`          — `"user:<id>"` or `"agent:<id>"`
 *   - `x-permissions`        — comma-separated permission claims
 *
 * Each header is independent: setting only `x-audience` overrides just
 * the audience field and leaves any cookie-derived requestor /
 * permissions in place.
 */
function applyDevOverrides(base: SessionUser, req: Request): SessionUser {
  if (process.env["NODE_ENV"] === "production") return base;

  let next: SessionUser = base;

  const audHdr = req.header("x-audience");
  if (audHdr === "internal" || audHdr === "user" || audHdr === "ai") {
    next = { ...next, audience: audHdr };
  }

  const reqHdr = req.header("x-requestor");
  if (reqHdr) {
    const idx = reqHdr.indexOf(":");
    if (idx > 0) {
      const kind = reqHdr.slice(0, idx);
      const id = reqHdr.slice(idx + 1);
      if ((kind === "user" || kind === "agent") && id.length > 0) {
        next = { ...next, requestor: { kind, id } };
      }
    }
  }

  const permHdr = req.header("x-permissions");
  if (typeof permHdr === "string" && permHdr.length > 0) {
    const perms = permHdr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (perms.length > 0) next = { ...next, permissions: perms };
  }

  return next;
}

/**
 * Express middleware that derives `req.session` from the request.
 *
 * Production: always returns the anonymous applicant default — both the
 * `pr_session` cookie and the override headers are stripped at the door
 * because neither carries a verifiable authentication signal yet (see
 * file header for the rationale). Once a real auth layer lands its
 * verifier should run *before* this middleware and replace
 * {@link ANONYMOUS_APPLICANT} with the verified identity it produced.
 *
 * Non-production: the cookie path and the dev override headers are
 * honored so local development, integration tests, and the operator CLI
 * can stand in for an authenticated session without round-tripping a
 * real login flow.
 *
 * Always sets `req.session` — anonymous requests get the least-privilege
 * applicant default rather than `undefined`, so downstream routes never
 * have to null-check. Requires `cookie-parser` to have run first so
 * `req.cookies` is populated; the wiring happens in `app.ts` and the
 * test setup helper.
 */
export const sessionMiddleware: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  // Fail-closed in production: ignore any client-supplied audience /
  // requestor / permission claims until a verified-auth path exists.
  // This is the central invariant the security review insisted on —
  // see the file header for the longer rationale.
  if (process.env["NODE_ENV"] === "production") {
    req.session = ANONYMOUS_APPLICANT;
    next();
    return;
  }

  // `req.cookies` is populated by the cookie-parser middleware. If it's
  // missing (e.g. someone forgot to wire cookie-parser) we still want a
  // session attached so routes don't crash — fall back to the anonymous
  // applicant default and log once so the misconfiguration is loud.
  const cookies = (req as Request & { cookies?: Record<string, unknown> })
    .cookies;
  if (!cookies) {
    logger.warn(
      "session middleware: req.cookies is undefined — cookie-parser is not wired",
    );
  }
  const fromCookie = parseSessionCookie(cookies?.[SESSION_COOKIE]);
  const base = fromCookie ?? ANONYMOUS_APPLICANT;
  req.session = applyDevOverrides(base, req);
  next();
};
