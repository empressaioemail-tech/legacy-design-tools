/**
 * T1-A (2026-10-22) — POST /api/account/delete  {confirm:"DELETE"}
 *
 * Requires a live signed-in session (a session TOKEN, checked server-side by
 * the revocation middleware; a service-impersonation call cannot delete an
 * account). Cancels any active Stripe subscription at period end, revokes all
 * sessions, deletes the user's personal data (`peAccountDelete.ts`).
 *   200 {ok:true}
 *   400 {error:"confirm_required"}       body.confirm !== "DELETE"
 *   401 {error:"authentication_required"}
 *   502 {error:"stripe_cancel_failed"}   nothing was deleted
 *   503 {error:"stripe_not_configured"}  nothing was deleted
 *
 * smartsite.cloud reaches this through the hauska-map BFF (see PR notes):
 * the BFF forwards `pe_session` as Bearer, then clears every `pe_*` cookie.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { SESSION_COOKIE } from "../middlewares/session";
import { deletePeAccount } from "../lib/peAccountDelete";
import { isAnonymousOwnerId } from "../lib/anonymousOwnerCookie";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/account/delete", async (req: Request, res: Response) => {
  const requestor = req.session.requestor;
  if (
    !req.peSessionToken ||
    requestor?.kind !== "user" ||
    !requestor.id ||
    isAnonymousOwnerId(requestor.id)
  ) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const confirm = (req.body as { confirm?: unknown } | undefined)?.confirm;
  if (confirm !== "DELETE") {
    res.status(400).json({ error: "confirm_required" });
    return;
  }
  try {
    const result = await deletePeAccount(requestor.id);
    if (!result.ok) {
      res
        .status(result.error === "stripe_not_configured" ? 503 : 502)
        .json({ error: result.error, message: result.message });
      return;
    }
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "pe account delete failed");
    res.status(500).json({ error: "account_delete_failed" });
  }
});

export default router;
