/**
 * Property Explorer session-exchange — BFF-verified OIDC identity → signed session.
 *
 * POST /api/auth/session-exchange
 * Authorization: Bearer <PE_SESSION_EXCHANGE_SECRET>
 *
 * WDLL items 13, 16 — user-aware session; no fake OAuth on Cortex side.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { DEFAULT_TENANT_ID, SESSION_COOKIE } from "../middlewares/session";
import { mintSessionToken } from "../lib/sessionToken";
import { upsertPeOidcIdentity, getPeAccessTier } from "../lib/peIdentity";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ExchangeBodySchema = z.object({
  provider: z.enum(["google", "microsoft"]),
  subject: z.string().min(1).max(256),
  email: z.string().email().optional(),
  displayName: z.string().max(256).optional(),
});

function exchangeSecret(): string | null {
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

function verifyExchangeAuth(req: Request): boolean {
  const secret = exchangeSecret();
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

function applicantSession(userId: string) {
  return {
    audience: "user" as const,
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user" as const, id: userId },
  };
}

function setSessionCookie(res: Response, token: string): void {
  const secure = process.env["NODE_ENV"] === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

router.post("/auth/session-exchange", async (req: Request, res: Response) => {
  if (!verifyExchangeAuth(req)) {
    res.status(401).json({ error: "exchange_unauthorized" });
    return;
  }
  const parsed = ExchangeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const identity = await upsertPeOidcIdentity(parsed.data);
    const token = mintSessionToken(applicantSession(identity.userId));
    const tier = await getPeAccessTier(identity.userId);
    setSessionCookie(res, token);
    res.status(identity.isNewUser ? 201 : 200).json({
      token,
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      entitlement: { tier },
    });
  } catch (err) {
    logger.error({ err }, "pe session-exchange failed");
    res.status(500).json({ error: "session_exchange_failed" });
  }
});

export default router;
