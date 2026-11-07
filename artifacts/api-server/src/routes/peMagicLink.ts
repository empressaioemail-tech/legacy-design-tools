/**
 * P-112 email leg, extended by T1-A (2026-10-22) — email sign-in for
 * Property Explorer.
 *
 * POST /api/auth/email/start     { email, returnTo?, campaign? }   T1-A
 *        -> 200 {sent:true} for any valid email shape (no account probing),
 *           429 {error:"rate_limited", retryAfterSec}. ONE email carries a
 *           6-digit code (10 min, 5 attempts) AND a link to the confirm
 *           page. Only successful sends count toward the rate limit.
 * POST /api/auth/email/verify    { email, code } | { token }, ...
 *        -> 201 new account / 200 returning, with the session token for the
 *           BFF to set as `pe_session`, plus `user` and `returnTo`.
 *           400 {error: code_invalid|code_expired|too_many_attempts|
 *           link_used|link_expired}.
 * GET  /api/auth/email/confirm?t=…                                   T1-A
 *        -> the link-confirm page: a "Finish signing in" button that POSTs
 *           the token. NEVER consumes it (mail scanners pre-fetch links). A
 *           used/expired link redirects to `/?auth_error=link_used|
 *           link_expired&returnTo=…`. `?format=json` answers
 *           {status, returnTo} instead, for a client-rendered page.
 * POST /api/auth/email/request   { email }        legacy link-only send,
 *        kept until the BFF moves to /email/start.
 *
 * start / verify / request sit behind the same `PE_SESSION_EXCHANGE_SECRET`
 * bearer check as `POST /auth/session-exchange` (`peExchangeAuth.ts`): the
 * BFF (hauska-map `apps/property-explorer/api/auth.ts`) is the only caller.
 * The confirm page needs no secret: it reveals nothing a link holder does
 * not already have, and consumes nothing.
 *
 * A verified address is upserted through the SAME `upsertPeOidcIdentity`
 * OAuth uses (provider "email", subject = the normalized address, email
 * proven), so it LINKS to an existing account holding the same verified
 * email (ruling 3), and is finished through the SAME `completePeSignIn`.
 *
 * No password anywhere in this flow (ruling addendum,
 * `_decisions/2026-09-04_p112_auth_options_ruling.md`).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { verifyPeExchangeAuth } from "../lib/peExchangeAuth";
import {
  consumeEmailLinkToken,
  createMagicLinkToken,
  discardUnsentMagicLinkToken,
  markMagicLinkSent,
  normalizeMagicLinkEmail,
  peekEmailLinkToken,
  startEmailSignIn,
  supersedeOlderEmailSignIns,
  verifyEmailCode,
} from "../lib/peMagicLink";
import { sendEmailSignInEmail, sendMagicLinkEmail } from "../lib/peMagicLinkEmail";
import { upsertPeOidcIdentity } from "../lib/peIdentity";
import { completePeSignIn } from "../lib/peSignInCompletion";
import { logger } from "../lib/logger";
import { normalizeAdMatch } from "../lib/peAdMatch";
import { authErrorRedirectPath } from "../lib/peReturnTo";
import { readPeSessionUser } from "../lib/peSessionUser";

const router: IRouter = Router();

const RequestBodySchema = z.object({
  email: z.string().min(3).max(254),
  /** First-touch campaign set; written onto the link (sanitized there). */
  campaign: z.string().max(512).optional(),
});

router.post("/auth/email/request", async (req: Request, res: Response) => {
  if (!verifyPeExchangeAuth(req)) {
    res.status(401).json({ error: "exchange_unauthorized" });
    return;
  }
  const parsed = RequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  const created = await createMagicLinkToken(parsed.data.email);
  if (!created.ok) {
    if (created.error === "invalid_email") {
      res.status(400).json({ error: "invalid_email" });
      return;
    }
    // rate_limited
    res.setHeader("Retry-After", String(created.retryAfterSeconds));
    res.status(429).json({
      error: "rate_limited",
      message: "Too many sign-in emails requested for this address. Try again shortly.",
      retryAfterSeconds: created.retryAfterSeconds,
    });
    return;
  }

  // Send to the SAME normalized address the token was stored against (not
  // the raw, possibly differently-cased input) — one canonical identity for
  // storage, lookup, and delivery alike.
  const normalizedEmail = normalizeMagicLinkEmail(parsed.data.email)!;
  const sent = await sendMagicLinkEmail({
    to: normalizedEmail,
    rawToken: created.rawToken,
    expiresAt: created.expiresAt,
    ...(parsed.data.campaign ? { campaign: parsed.data.campaign } : {}),
  });
  if (!sent.ok) {
    // Honest failure, never a fake "check your email" success (see
    // peMagicLinkEmail.ts header — this is the one place in this flow
    // where the established fail-open SHAPE does not mean fail-open
    // OUTCOME: sending the email is this endpoint's entire job).
    // T1-A: the unsent row is deleted, so the failure does not count
    // toward the address's rate limit.
    await discardUnsentMagicLinkToken(created.rowId);
    logger.error(
      { error: sent.error },
      "pe magic-link: Resend send failed, surfacing honest error",
    );
    res.status(502).json({
      error: "send_failed",
      message: "Could not send the sign-in email. Please try again.",
    });
    return;
  }
  await markMagicLinkSent(created.rowId);

  res.status(200).json({
    ok: true,
    expiresAt: created.expiresAt.toISOString(),
  });
});

const StartBodySchema = z.object({
  email: z.string().min(1).max(254),
  /** Same-site relative path to land on after sign-in; anything else becomes "/". */
  returnTo: z.string().max(2048).optional(),
  /** First-touch campaign set; written onto the link (sanitized there). */
  campaign: z.string().max(512).optional(),
});

router.post("/auth/email/start", async (req: Request, res: Response) => {
  if (!verifyPeExchangeAuth(req)) {
    res.status(401).json({ error: "exchange_unauthorized" });
    return;
  }
  const parsed = StartBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  const started = await startEmailSignIn(parsed.data.email, {
    returnTo: parsed.data.returnTo,
  });
  if (!started.ok) {
    if (started.error === "invalid_email") {
      res.status(400).json({ error: "invalid_email" });
      return;
    }
    res.setHeader("Retry-After", String(started.retryAfterSeconds));
    res.status(429).json({
      error: "rate_limited",
      retryAfterSec: started.retryAfterSeconds,
    });
    return;
  }
  const sent = await sendEmailSignInEmail({
    to: started.email,
    code: started.code,
    rawToken: started.rawToken,
    expiresAt: started.expiresAt,
    ...(parsed.data.campaign ? { campaign: parsed.data.campaign } : {}),
  });
  if (!sent.ok) {
    // A provider failure is not account-dependent, so an honest 502 leaks
    // nothing about which addresses have accounts. The row is deleted so the
    // failure never counts toward the rate limit.
    await discardUnsentMagicLinkToken(started.rowId);
    logger.error({ error: sent.error }, "pe email sign-in: Resend send failed");
    res.status(502).json({
      error: "send_failed",
      message: "Could not send the sign-in email. Please try again.",
    });
    return;
  }
  const sentAt = new Date();
  await markMagicLinkSent(started.rowId, sentAt);
  // Only the newest code and link work: older outstanding ones expire now.
  await supersedeOlderEmailSignIns(
    started.email,
    { rowId: started.rowId, createdAt: started.createdAt },
    sentAt,
  );
  res.status(200).json({ sent: true });
});

const VerifyBodySchema = z.object({
  /** Link flow: the raw token from the confirm page's POST. */
  token: z.string().min(1).max(512).optional(),
  /** Code flow: the address the code was sent to, and the 6-digit code. */
  email: z.string().min(1).max(254).optional(),
  code: z.string().min(1).max(16).optional(),
  installId: z.string().min(8).max(256).optional(),
  /**
   * First-touch campaign set. The BFF still has it at verify time when the
   * visitor requested the link from the same browser that landed on the ad.
   * Absent means `ss_src_direct`, not a guessed tag.
   */
  campaign: z.string().max(512).optional(),
  /** The verifying browser's Meta match keys; see peAuth.ts. */
  metaMatch: z.unknown().optional(),
});

router.post("/auth/email/verify", async (req: Request, res: Response) => {
  if (!verifyPeExchangeAuth(req)) {
    res.status(401).json({ error: "exchange_unauthorized" });
    return;
  }
  const parsed = VerifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const body = parsed.data;

  let verified: Awaited<ReturnType<typeof verifyEmailCode>>;
  if (body.token) {
    verified = await consumeEmailLinkToken(body.token);
  } else if (body.email && body.code) {
    verified = await verifyEmailCode(body.email, body.code);
  } else {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  if (!verified.ok) {
    res.status(400).json({ error: verified.error });
    return;
  }

  try {
    const identity = await upsertPeOidcIdentity({
      provider: "email",
      subject: verified.email,
      email: verified.email,
      emailVerified: true,
    });
    const completion = await completePeSignIn(req, res, identity, {
      ...(body.installId ? { installId: body.installId } : {}),
      ...(body.campaign ? { campaign: body.campaign } : {}),
      adMatch: normalizeAdMatch(body.metaMatch),
    });
    const user = await readPeSessionUser(identity.userId);
    res.status(identity.isNewUser ? 201 : 200).json({
      ...completion,
      user,
      returnTo: verified.returnTo,
    });
  } catch (err) {
    logger.error({ err }, "pe email verify: sign-in completion failed");
    res.status(500).json({ error: "sign_in_failed" });
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The link-confirm page. The form posts to the BFF's same-origin verify route. */
export function renderEmailLinkConfirmPage(rawToken: string): string {
  const token = escapeHtml(rawToken);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Finish signing in · Smart Site</title>
<style>
:root{color-scheme:light dark;--bg:#0b0f14;--card:#121821;--fg:#e8edf3;--muted:#94a3b8;--accent:#3b82f6}
@media (prefers-color-scheme: light){:root{--bg:#f5f7fa;--card:#fff;--fg:#0f172a;--muted:#475569}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border-radius:16px;padding:28px 24px;text-align:center}
h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 20px;color:var(--muted)}
button{width:100%;min-height:48px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:600 16px/1 inherit;cursor:pointer}
</style>
</head>
<body>
<main>
<h1>Finish signing in</h1>
<p>Tap the button to sign in to Smart Site on this device.</p>
<form method="post" action="/api/auth/email/verify">
<input type="hidden" name="token" value="${token}">
<button type="submit">Finish signing in</button>
</form>
</main>
</body>
</html>`;
}

router.get("/auth/email/confirm", async (req: Request, res: Response) => {
  const raw = typeof req.query["t"] === "string" ? req.query["t"] : "";
  const peek = await peekEmailLinkToken(raw);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  if (req.query["format"] === "json") {
    res.status(200).json({ status: peek.status, returnTo: peek.returnTo });
    return;
  }
  if (peek.status !== "valid") {
    res.redirect(
      302,
      authErrorRedirectPath(
        peek.status === "used" ? "link_used" : "link_expired",
        peek.returnTo,
      ),
    );
    return;
  }
  res.status(200).type("html").send(renderEmailLinkConfirmPage(raw));
});

export default router;
