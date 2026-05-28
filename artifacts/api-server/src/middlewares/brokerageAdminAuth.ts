import type { Request, Response, NextFunction } from "express";

function loadAdminKeys(): Set<string> {
  const keys = new Set<string>();
  const raw = process.env.BROKERAGE_ADMIN_API_KEYS?.trim();
  if (!raw) return keys;
  for (const part of raw.split(",")) {
    const k = part.trim();
    if (k) keys.add(k);
  }
  return keys;
}

export function brokerageAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const keys = loadAdminKeys();
  if (keys.size === 0) {
    res.status(503).json({
      error: "admin_unconfigured",
      message: "BROKERAGE_ADMIN_API_KEYS is not configured",
    });
    return;
  }

  const header =
    typeof req.headers["x-brokerage-admin-key"] === "string"
      ? req.headers["x-brokerage-admin-key"].trim()
      : null;

  if (!header || !keys.has(header)) {
    res.status(401).json({ error: "unauthorized", message: "Invalid admin key" });
    return;
  }

  next();
}
