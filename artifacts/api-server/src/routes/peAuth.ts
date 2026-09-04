/**
 * Property Explorer session-exchange — BFF-verified OIDC identity → signed session.
 *
 * POST /api/auth/session-exchange
 * Authorization: Bearer <PE_SESSION_EXCHANGE_SECRET>
 *
 * WDLL items 13, 16 — user-aware session; no fake OAuth on Cortex side.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { upsertPeOidcIdentity } from "../lib/peIdentity";
import { completePeSignIn } from "../lib/peSignInCompletion";
import { verifyPeExchangeAuth } from "../lib/peExchangeAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ExchangeBodySchema = z.object({
  provider: z.enum(["google", "microsoft"]),
  subject: z.string().min(1).max(256),
  email: z.string().email().optional(),
  displayName: z.string().max(256).optional(),
  /** Anonymous pre-auth install to claim (WDLL 2026-08-05 item 6). Header takes precedence when both present. */
  installId: z.string().min(8).max(256).optional(),
});

router.post("/auth/session-exchange", async (req: Request, res: Response) => {
  if (!verifyPeExchangeAuth(req)) {
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
    const body = await completePeSignIn(req, res, identity, parsed.data.installId);
    res.status(identity.isNewUser ? 201 : 200).json(body);
  } catch (err) {
    logger.error({ err }, "pe session-exchange failed");
    res.status(500).json({ error: "session_exchange_failed" });
  }
});

export default router;
