/**
 * P-112 email leg — magic-link sign-in for Property Explorer.
 *
 * POST /api/auth/email/request   { email }        -> mint + email a token
 * POST /api/auth/email/verify    { token, ... }    -> redeem + sign in
 *
 * Both routes sit behind the same `PE_SESSION_EXCHANGE_SECRET` bearer check
 * `POST /auth/session-exchange` already uses (`peExchangeAuth.ts`) — the BFF
 * (hauska-map `apps/property-explorer/api/auth.ts`) is the only caller, the
 * same way it is the only caller of session-exchange. The browser never
 * talks to this Cortex API directly; it hits the BFF's own
 * `/api/auth/email/*` routes, which proxy here server-to-server.
 *
 * Verification happens entirely in this process (token hash lookup against
 * `pe_magic_link_tokens`) — unlike OAuth, there is no third-party identity
 * provider to trust, so there is no separate "BFF verifies, then asserts"
 * step. A verified email is upserted through the SAME `upsertPeOidcIdentity`
 * function OAuth uses (provider: "email", subject: the normalized email
 * itself — magic link has no external subject, the address IS the durable
 * identifier) and finished through the SAME `completePeSignIn` helper
 * session-exchange uses, so a magic-link account is a `users` row created
 * and signed in exactly the way an OAuth account is: same entitlement
 * bootstrap, same isNewUser-gated GHL contact hook, same session cookie.
 *
 * No password anywhere in this flow (ruling addendum,
 * `_decisions/2026-09-04_p112_auth_options_ruling.md`).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { verifyPeExchangeAuth } from "../lib/peExchangeAuth";
import {
  createMagicLinkToken,
  consumeMagicLinkToken,
  normalizeMagicLinkEmail,
} from "../lib/peMagicLink";
import { sendMagicLinkEmail } from "../lib/peMagicLinkEmail";
import { upsertPeOidcIdentity } from "../lib/peIdentity";
import { completePeSignIn } from "../lib/peSignInCompletion";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const RequestBodySchema = z.object({
  email: z.string().min(3).max(254),
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
  });
  if (!sent.ok) {
    // Honest failure, never a fake "check your email" success (see
    // peMagicLinkEmail.ts header — this is the one place in this flow
    // where the established fail-open SHAPE does not mean fail-open
    // OUTCOME: sending the email is this endpoint's entire job).
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

  res.status(200).json({
    ok: true,
    expiresAt: created.expiresAt.toISOString(),
  });
});

const VerifyBodySchema = z.object({
  token: z.string().min(1).max(512),
  installId: z.string().min(8).max(256).optional(),
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

  const consumed = await consumeMagicLinkToken(parsed.data.token);
  if (!consumed.ok) {
    // Distinct, honest status per reason — never a single generic failure.
    const statusByError: Record<typeof consumed.error, number> = {
      malformed: 400,
      not_found: 404,
      expired: 410,
      already_used: 409,
    };
    res.status(statusByError[consumed.error]).json({ error: consumed.error });
    return;
  }

  try {
    const identity = await upsertPeOidcIdentity({
      provider: "email",
      subject: consumed.email,
      email: consumed.email,
    });
    const body = await completePeSignIn(req, res, identity, parsed.data.installId);
    res.status(identity.isNewUser ? 201 : 200).json(body);
  } catch (err) {
    logger.error({ err }, "pe magic-link verify: sign-in completion failed");
    res.status(500).json({ error: "sign_in_failed" });
  }
});

export default router;
