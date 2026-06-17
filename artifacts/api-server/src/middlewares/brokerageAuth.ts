import type { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/sessionToken";

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
let cachedExtensionPublicKey: string | null | undefined;

function loadExtensionPublicKey(): string | null {
  if (cachedExtensionPublicKey !== undefined) {
    return cachedExtensionPublicKey;
  }
  const raw = process.env.BROKERAGE_EXTENSION_PUBLIC_KEY?.trim();
  cachedExtensionPublicKey = raw || null;
  return cachedExtensionPublicKey;
}

export function loadBrokerageApiKeys(): Set<string> {
  if (cachedKeys) return cachedKeys;
  const keys = new Set<string>();
  for (const envName of ["BROKERAGE_API_KEYS", "BROKERAGE_EXTENSION_PUBLIC_KEY"]) {
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
  cachedExtensionPublicKey = undefined;
}

export function resolveBrokerageClientTier(providedKey: string): BrokerageClientTier {
  const publicKey = loadExtensionPublicKey();
  if (publicKey && providedKey === publicKey) return "extension_public";
  return "operator";
}

export function isExtensionPublicClient(req: Request): boolean {
  return req.brokerageAuth?.tier === "extension_public";
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
  const keys = loadBrokerageApiKeys();
  if (keys.size === 0) {
    res.status(503).json({
      error: "property_brief_api_unconfigured",
      message: "Property Brief API key is not configured on this server",
    });
    return;
  }

  const provided = extractBrokerageApiKey(req);

  if (provided && keys.has(provided)) {
    req.brokerageAuth = { tier: resolveBrokerageClientTier(provided) };
    next();
    return;
  }

  if (provided?.includes(".")) {
    const verified = verifySessionToken(provided);
    if (verified.ok && verified.session.requestor?.kind === "user") {
      req.session = verified.session;
      req.brokerageAuth = { tier: "user" };
      next();
      return;
    }
  }

  res.status(401).json({
    error: "unauthorized",
    message: "Valid Authorization Bearer or X-Hauska-Key required",
  });
}
