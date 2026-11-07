/**
 * T1-A (2026-10-22) — server-validated Property Explorer session.
 *
 * GET /api/auth/session
 *   Authorization: Bearer <pe_session token>   (the BFF forwards the cookie)
 *   -> {signedIn:false}
 *    | {signedIn:true, user:{id,email,plan,planStatus,providers,createdAt},
 *       session?: {token, expiresAt}}
 *
 * Validates the token server-side: HMAC signature, `exp`, revocation (logout,
 * account delete, account merge) and the sliding expiry (`peSessions.ts`).
 * Sliding refresh: a live token older than a day comes back re-minted in
 * `session` (and as Cortex's own cookie); the BFF must re-set `pe_session`
 * from `session.token` and must never pass `session` through to the browser.
 *
 * POST /api/auth/logout lives in `routes/auth.ts` and now revokes the
 * presented token server-side as well.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { checkSessionTokenLive, refreshPeSessionToken } from "../lib/peSessions";
import { readPeSessionUser } from "../lib/peSessionUser";
import { setPeSessionCookie } from "../lib/peSignInCompletion";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/auth/session", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const token = req.peSessionToken;
  if (!token) {
    res.status(200).json({ signedIn: false });
    return;
  }
  try {
    const live = await checkSessionTokenLive(token);
    if (!live.live) {
      res.status(200).json({ signedIn: false });
      return;
    }
    const user = await readPeSessionUser(live.userId);
    if (!user) {
      res.status(200).json({ signedIn: false });
      return;
    }
    const refreshed = await refreshPeSessionToken(live);
    if (refreshed) setPeSessionCookie(res, refreshed.token);
    res.status(200).json({
      signedIn: true,
      user,
      ...(refreshed
        ? {
            session: {
              token: refreshed.token,
              expiresAt: refreshed.expiresAt.toISOString(),
            },
          }
        : {}),
    });
  } catch (err) {
    logger.error({ err }, "pe session check failed");
    res.status(503).json({ error: "session_check_failed" });
  }
});

export default router;
