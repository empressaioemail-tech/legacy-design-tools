/**
 * Shared "finish a PE sign-in" step — used by BOTH the OIDC session-exchange
 * route (`routes/peAuth.ts`) and the magic-link verify route
 * (`routes/peMagicLink.ts`) so an account created through either path is
 * provably indistinguishable afterward: the exact same session-minting
 * call, the exact same isNewUser-gated GHL-new-signup hook, the exact same
 * anonymous-install-claim behavior. One function, not two copies that can
 * drift — the risk this factoring exists to close.
 */

import type { Request, Response } from "express";
import { DEFAULT_TENANT_ID, SESSION_COOKIE } from "../middlewares/session";
import { mintSessionToken } from "./sessionToken";
import { getPeAccessTier, type PeIdentityResult } from "./peIdentity";
import { installIdFromRequest } from "./brokerageInstallId";
import { claimInstallHistoryForUser } from "./brokerageInstallClaim";
import { notifyGhlOfNewPeSignup } from "./peGhlContact";
import { logger } from "./logger";

function applicantSession(userId: string) {
  return {
    audience: "user" as const,
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user" as const, id: userId },
  };
}

export function setPeSessionCookie(res: Response, token: string): void {
  const secure = process.env["NODE_ENV"] === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export type PeSignInCompletionBody = {
  token: string;
  userId: string;
  email: string | null;
  displayName: string;
  entitlement: { tier: "free" | "paid" };
  claimedInstallHistory: boolean;
};

/**
 * Mint the session, set the cookie, fire the new-signup GHL hook exactly
 * when `identity.isNewUser` (a brand-new `users` row was just created —
 * true for a first OAuth sign-in AND for a first magic-link verification
 * alike), and claim any anonymous install history. Returns the same
 * response-body shape `POST /auth/session-exchange` has always returned,
 * so callers on either path get an identical contract.
 */
export async function completePeSignIn(
  req: Request,
  res: Response,
  identity: PeIdentityResult,
  installIdFromBody?: string,
): Promise<PeSignInCompletionBody> {
  const token = mintSessionToken(applicantSession(identity.userId));
  const tier = await getPeAccessTier(identity.userId);
  setPeSessionCookie(res, token);

  // Real signup only (WDLL/decision-doc signal: isNewUser === a brand-new
  // `users` row was just created by upsertPeOidcIdentity, not a returning
  // sign-in). Best-effort, fail-open — see peGhlContact.ts.
  if (identity.isNewUser && identity.email) {
    try {
      await notifyGhlOfNewPeSignup({
        email: identity.email,
        displayName: identity.displayName,
      });
    } catch (err) {
      // notifyGhlOfNewPeSignup already swallows its own failures; this is a
      // last-resort backstop so a truly unexpected throw here can never
      // turn a successful sign-up into a 500.
      logger.error(
        { err },
        "pe sign-in: GHL contact hook threw unexpectedly (swallowed, fail-open)",
      );
    }
  }

  // Anonymous claim (WDLL 2026-08-05 item 6): the header wins over a body
  // field so the BFF's own install-id plumbing (X-Hauska-Install-Id) is
  // authoritative when both are present. Claim failures never fail sign-in
  // — this is best-effort data recovery, not an auth precondition.
  const installId = installIdFromRequest(req) ?? installIdFromBody ?? null;
  let claimedInstallHistory = false;
  if (installId) {
    const claim = await claimInstallHistoryForUser(installId, identity.userId);
    claimedInstallHistory = claim.ok && claim.claimed;
    if (!claim.ok) {
      logger.info(
        { installId, userId: identity.userId, claimedBy: claim.claimedBy },
        "pe sign-in: install already claimed by a different user",
      );
    }
  }

  return {
    token,
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    entitlement: { tier },
    claimedInstallHistory,
  };
}
