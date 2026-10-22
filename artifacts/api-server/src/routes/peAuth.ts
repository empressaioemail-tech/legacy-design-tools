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
import { normalizeAdMatch } from "../lib/peAdMatch";

const router: IRouter = Router();

const ExchangeBodySchema = z.object({
  /**
   * "microsoft" is still accepted here ONLY because the MCP connector's
   * login page (hauska-map api/_lib/mcp-login-page.ts) and existing
   * Microsoft-created accounts sign in through this exchange. The app no
   * longer offers Microsoft (T1 ruling 2, 2026-10-22), and a Microsoft
   * identity is never trusted for email linking (peIdentityEmailVerified).
   */
  provider: z.enum(["google", "microsoft"]),
  subject: z.string().min(1).max(256),
  email: z.string().email().optional(),
  /**
   * T1-A: the IdP's own verified-email claim (Google ID token
   * `email_verified`), forwarded by the BFF. Only a true value lets this
   * identity link to an existing account with the same verified email.
   * Absent (every BFF build before T1-A) means unverified: no linking.
   */
  emailVerified: z.boolean().optional(),
  displayName: z.string().max(256).optional(),
  /** Anonymous pre-auth install to claim (WDLL 2026-08-05 item 6). Header takes precedence when both present. */
  installId: z.string().min(8).max(256).optional(),
  /**
   * First-touch campaign set, forwarded by the BFF from the sealed OIDC
   * state (hauska-map `api/_lib/campaign.ts`). Absent when the visitor
   * arrived with no parameters; absence is `ss_src_direct` downstream.
   */
  campaign: z.string().max(512).optional(),
  /**
   * The signing-in browser's Meta match keys (hauska-map
   * api/_lib/meta-signin-handoff.ts metaMatchForCortex). Shape-validated by
   * normalizeAdMatch; a malformed value is dropped, never a 400.
   */
  metaMatch: z.unknown().optional(),
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
    const body = await completePeSignIn(req, res, identity, {
      ...(parsed.data.installId ? { installId: parsed.data.installId } : {}),
      ...(parsed.data.campaign ? { campaign: parsed.data.campaign } : {}),
      adMatch: normalizeAdMatch(parsed.data.metaMatch),
    });
    res.status(identity.isNewUser ? 201 : 200).json(body);
  } catch (err) {
    logger.error({ err }, "pe session-exchange failed");
    res.status(500).json({ error: "session_exchange_failed" });
  }
});

export default router;
