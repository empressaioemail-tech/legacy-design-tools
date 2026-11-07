/**
 * Shared BFF-exchange bearer-secret check — `PE_SESSION_EXCHANGE_SECRET`
 * (falling back to `SESSION_SECRET`), the same auth gate `peAuth.ts`'s
 * `POST /auth/session-exchange` has always used, now also guarding
 * `routes/peMagicLink.ts`'s two routes. One place, so the two never drift.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export function peExchangeSecret(): string | null {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"]?.trim() ||
    process.env["SESSION_SECRET"]?.trim();
  return secret || null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function verifyPeExchangeAuth(req: Request): boolean {
  const secret = peExchangeSecret();
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return timingSafeStringEqual(auth.slice(7), secret);
  }
  const header = req.headers["x-pe-exchange-secret"];
  if (typeof header === "string") {
    return timingSafeStringEqual(header, secret);
  }
  return false;
}
