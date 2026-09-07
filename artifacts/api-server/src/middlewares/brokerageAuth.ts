import type { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/sessionToken";

/**
 * RETIRED (operator ruling, 2026-09-07: "cut the chrome extension we don't
 * need it"). "extension_public" was the ONLY tier the chrome extension
 * (hauska-brief-extension) ever authenticated as — confirmed dead in
 * production before retiring: 248 brokerage_brief_runs total, ever, since
 * 2026-05-26, ZERO since 2026-08-09. Kept in the type union (rather than
 * deleted outright) because `/brief`, `/brief/summarize`, and
 * `/research/chat` still branch on `isExtensionPublicClient` for their own
 * rate-limiting/billing logic — that branching is now permanently dead code
 * (this tier can never be assigned again, see loadBrokerageApiKeys and
 * resolveBrokerageClientTier below), not a route deletion. A caller
 * presenting the old BROKERAGE_EXTENSION_PUBLIC_KEY now falls straight
 * through brokerageAuth's own unauthorized path — same 401 an unrecognized
 * key already got, no new response shape.
 */
export type BrokerageClientTier = "operator" | "extension_public" | "user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by {@link brokerageAuth} after a valid API key is presented. */
      brokerageAuth?: { tier: BrokerageClientTier };
    }
  }
}

let cachedKeys: Set<string> | null = null;

export function loadBrokerageApiKeys(): Set<string> {
  if (cachedKeys) return cachedKeys;
  const keys = new Set<string>();
  // RETIRED: "BROKERAGE_EXTENSION_PUBLIC_KEY" deliberately removed from this
  // list (see the BrokerageClientTier doc comment above) — a caller
  // presenting that key must no longer authenticate as anything.
  for (const envName of [
    "BROKERAGE_OPERATOR_API_KEYS",
    "BROKERAGE_API_KEYS",
  ]) {
    const raw = process.env[envName]?.trim();
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const k = part.trim();
      if (k) keys.add(k);
    }
  }
  cachedKeys = keys;
  return keys;
}

/** TEST-ONLY: reset cached keys after env changes. */
export function resetBrokerageApiKeysForTests(): void {
  cachedKeys = null;
}

export function resolveBrokerageClientTier(_providedKey: string): BrokerageClientTier {
  // RETIRED: never resolves "extension_public" — a second, independent
  // enforcement point alongside loadBrokerageApiKeys' own removal of
  // BROKERAGE_EXTENSION_PUBLIC_KEY from the recognized-key set, so re-adding
  // the key to only one of the two spots still can't reopen the tier.
  return "operator";
}

export function isExtensionPublicClient(req: Request): boolean {
  return req.brokerageAuth?.tier === "extension_public";
}

/** Signed-in brokerage user (session Bearer → tier `user`). */
export function authenticatedBrokerageUserId(req: Request): string | null {
  if (req.brokerageAuth?.tier !== "user") return null;
  if (req.session?.requestor?.kind !== "user") return null;
  const id = req.session.requestor.id.trim();
  if (!id || id.startsWith("anon_")) return null;
  return id;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

export function extractBrokerageApiKey(req: Request): string | null {
  const fromBearer = extractBearerToken(req.headers.authorization);
  const fromHeader =
    typeof req.headers["x-hauska-key"] === "string"
      ? req.headers["x-hauska-key"].trim()
      : null;
  return fromBearer ?? fromHeader;
}

export function brokerageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provided = extractBrokerageApiKey(req);

  // Session-JWT verification is independent of whether any static API key
  // is configured — checked FIRST so an unconfigured key set never blocks a
  // real logged-in user. Production has never provisioned
  // BROKERAGE_OPERATOR_API_KEYS/BROKERAGE_API_KEYS as Cloud Run secrets;
  // BROKERAGE_EXTENSION_PUBLIC_KEY was the only thing keeping
  // loadBrokerageApiKeys() non-empty, so its retirement (2026-09-07) would
  // otherwise 503 every session-authenticated request too, not just
  // API-key callers.
  if (provided?.includes(".")) {
    const verified = verifySessionToken(provided);
    if (verified.ok && verified.session.requestor?.kind === "user") {
      req.session = verified.session;
      req.brokerageAuth = { tier: "user" };
      next();
      return;
    }
  }

  const keys = loadBrokerageApiKeys();
  if (keys.size === 0) {
    res.status(503).json({
      error: "property_brief_api_unconfigured",
      message: "Property Brief API key is not configured on this server",
    });
    return;
  }

  if (provided && keys.has(provided)) {
    req.brokerageAuth = { tier: resolveBrokerageClientTier(provided) };
    next();
    return;
  }

  res.status(401).json({
    error: "unauthorized",
    message: "Valid Authorization Bearer or X-Hauska-Key required",
  });
}
