/**
 * P-456b. Seat-only access to map render metrics (aggregate counts, no PII).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export function loadSeatMetricsKey(): string | null {
  return (
    process.env.SMARTSITE_MCP_SEAT_METRICS_KEY?.trim() ||
    process.env.SERVICE_API_KEY?.trim() ||
    null
  );
}

function tokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const t = header.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const seat = req.headers["x-smartsite-seat-key"];
  if (typeof seat === "string" && seat.trim()) return seat.trim();
  return null;
}

export function mintMapRenderReportToken(correlationId: string): string | null {
  const key = loadSeatMetricsKey();
  if (!key) return null;
  return createHmac("sha256", key).update(correlationId.trim()).digest("hex");
}

export function verifyMapRenderReportToken(
  correlationId: string,
  reportToken: string,
): boolean {
  const expected = mintMapRenderReportToken(correlationId);
  if (!expected) return false;
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(reportToken.trim(), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function requireSeatMetricsKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = loadSeatMetricsKey();
  if (!expected) {
    res.status(503).json({
      error: "seat_metrics_key_not_configured",
      message: "Map render metrics require SMARTSITE_MCP_SEAT_METRICS_KEY or SERVICE_API_KEY.",
    });
    return;
  }
  const got = tokenFromRequest(req);
  if (!got || got !== expected) {
    res.status(401).json({
      error: "unauthorized",
      message: "Seat metrics key required.",
    });
    return;
  }
  next();
}

/** Card beacon: HMAC tied to one correlation id, or the seat key for probes. */
export function requireSeatMetricsOrReportToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = loadSeatMetricsKey();
  if (!expected) {
    res.status(503).json({
      error: "seat_metrics_key_not_configured",
      message: "Map render metrics require SMARTSITE_MCP_SEAT_METRICS_KEY or SERVICE_API_KEY.",
    });
    return;
  }
  const got = tokenFromRequest(req);
  if (got && got === expected) {
    next();
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const correlationId =
    typeof body?.correlationId === "string" ? body.correlationId : "";
  const reportToken =
    typeof body?.reportToken === "string" ? body.reportToken : "";
  if (
    correlationId &&
    reportToken &&
    verifyMapRenderReportToken(correlationId, reportToken)
  ) {
    next();
    return;
  }
  res.status(401).json({
    error: "unauthorized",
    message: "Seat metrics key or valid report token required.",
  });
}
