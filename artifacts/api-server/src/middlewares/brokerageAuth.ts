import type { Request, Response, NextFunction } from "express";

let cachedKeys: Set<string> | null = null;

function loadBrokerageApiKeys(): Set<string> {
  if (cachedKeys) return cachedKeys;
  const keys = new Set<string>();
  for (const envName of ["BROKERAGE_DEV_API_KEY", "BROKERAGE_API_KEYS"]) {
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

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

export function brokerageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const keys = loadBrokerageApiKeys();
  if (keys.size === 0) {
    res.status(503).json({
      error: "brokerage_api_unconfigured",
      message: "BROKERAGE_DEV_API_KEY is not configured on this server",
    });
    return;
  }

  const fromBearer = extractBearerToken(req.headers.authorization);
  const fromHeader =
    typeof req.headers["x-hauska-key"] === "string"
      ? req.headers["x-hauska-key"].trim()
      : null;
  const provided = fromBearer ?? fromHeader;

  if (!provided || !keys.has(provided)) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid Authorization Bearer or X-Hauska-Key required",
    });
    return;
  }

  next();
}
