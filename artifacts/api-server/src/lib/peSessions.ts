/**
 * T1-A (2026-10-22) — server-side Property Explorer sessions: revocation and
 * sliding expiry on top of the stateless HMAC session token.
 *
 * - Every PE sign-in creates a `pe_sessions` row and mints a token carrying
 *   its id as the `sid` claim ({@link createPeSessionToken}).
 * - A token is LIVE when its HMAC and `exp` verify AND, when it has a `sid`,
 *   its row exists, is not revoked and is not past `expires_at`, AND it was
 *   issued after the user's `pe_session_cutoffs.not_before` (if any). A
 *   pre-`sid` (legacy) token is live unless a `legacy:<sha256>` denylist row
 *   revokes it or the user cutoff postdates it ({@link checkSessionTokenLive}).
 * - Sliding expiry: {@link refreshPeSessionToken} re-mints a token older than
 *   {@link SESSION_REFRESH_AFTER_SEC} with a fresh 7-day `exp` and moves the
 *   row's `expires_at` forward. An active user is never logged out at day 7.
 *   A legacy token is upgraded to a `sid` token on its first refresh.
 * - Logout revokes the presented token ({@link revokePeSessionToken}); account
 *   delete and the duplicate-account merge revoke every token a user holds
 *   ({@link revokeAllPeSessionsForUser}).
 *
 * Nothing here logs a token.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, peSessionCutoffs, peSessions } from "@workspace/db";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TTL_SEC,
  mintSessionToken,
  verifiedSessionTokenClaims,
} from "./sessionToken";

/** Sliding window: an active session is extended to this from its last refresh. */
export const SESSION_TTL_SEC = DEFAULT_TTL_SEC;
/** A token older than this is re-minted on the next session check. */
export const SESSION_REFRESH_AFTER_SEC = 24 * 60 * 60;

function newSessionId(): string {
  return `ps_${randomBytes(16).toString("hex")}`;
}

function legacySessionRowId(token: string): string {
  return `legacy:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function userSession(userId: string) {
  return {
    audience: "user" as const,
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user" as const, id: userId },
  };
}

export type MintedPeSession = { token: string; sid: string; expiresAt: Date };

/** Create a `pe_sessions` row and mint a token bound to it. */
export async function createPeSessionToken(
  userId: string,
  now: Date = new Date(),
): Promise<MintedPeSession> {
  const sid = newSessionId();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
  await db.insert(peSessions).values({
    id: sid,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  const token = mintSessionToken(userSession(userId), SESSION_TTL_SEC, { sid });
  return { token, sid, expiresAt };
}

export type SessionLiveness =
  | { live: true; userId: string; sid: string | null; iat: number }
  | {
      live: false;
      reason:
        | "invalid"
        | "not_user"
        | "revoked"
        | "expired"
        | "unknown_session"
        | "cut_off";
    };

/**
 * Full server-side check of a session token: signature, `exp`, revocation,
 * sliding expiry and the user cutoff. Throws only on a database error (the
 * caller decides fail-open vs fail-closed).
 */
export async function checkSessionTokenLive(
  token: string,
  now: Date = new Date(),
): Promise<SessionLiveness> {
  let claims: ReturnType<typeof verifiedSessionTokenClaims>;
  try {
    claims = verifiedSessionTokenClaims(token);
  } catch {
    return { live: false, reason: "invalid" };
  }
  if (!claims) return { live: false, reason: "invalid" };
  const requestor = claims.session.requestor;
  if (requestor?.kind !== "user" || !requestor.id) {
    return { live: false, reason: "not_user" };
  }
  const userId = requestor.id;
  const rowId = claims.sid ?? legacySessionRowId(token);

  const [row] = await db
    .select({
      userId: peSessions.userId,
      expiresAt: peSessions.expiresAt,
      revokedAt: peSessions.revokedAt,
    })
    .from(peSessions)
    .where(eq(peSessions.id, rowId))
    .limit(1);

  if (claims.sid) {
    if (!row || row.userId !== userId) return { live: false, reason: "unknown_session" };
    if (row.revokedAt) return { live: false, reason: "revoked" };
    if (row.expiresAt.getTime() <= now.getTime()) {
      return { live: false, reason: "expired" };
    }
  } else if (row?.revokedAt) {
    return { live: false, reason: "revoked" };
  }

  const [cutoff] = await db
    .select({ notBefore: peSessionCutoffs.notBefore })
    .from(peSessionCutoffs)
    .where(eq(peSessionCutoffs.userId, userId))
    .limit(1);
  // `iat` is whole seconds; a token minted in the same second as the cutoff
  // (but before it) must still die, hence `<=` against the floored cutoff.
  if (cutoff && claims.iat <= Math.floor(cutoff.notBefore.getTime() / 1000)) {
    return { live: false, reason: "cut_off" };
  }
  return { live: true, userId, sid: claims.sid, iat: claims.iat };
}

/**
 * Sliding refresh. Given a token that {@link checkSessionTokenLive} reported
 * live, return a new token (and move the row's expiry) when it is older than
 * {@link SESSION_REFRESH_AFTER_SEC}; otherwise null (keep the current one).
 * A legacy token is upgraded to a fresh `sid` session.
 */
export async function refreshPeSessionToken(
  liveness: Extract<SessionLiveness, { live: true }>,
  now: Date = new Date(),
): Promise<MintedPeSession | null> {
  const nowSec = Math.floor(now.getTime() / 1000);
  if (nowSec - liveness.iat < SESSION_REFRESH_AFTER_SEC) {
    if (liveness.sid) {
      await db
        .update(peSessions)
        .set({ lastSeenAt: now })
        .where(eq(peSessions.id, liveness.sid));
    }
    return null;
  }
  if (!liveness.sid) {
    return createPeSessionToken(liveness.userId, now);
  }
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
  const updated = await db
    .update(peSessions)
    .set({ lastSeenAt: now, expiresAt })
    .where(and(eq(peSessions.id, liveness.sid), isNull(peSessions.revokedAt)))
    .returning({ id: peSessions.id });
  if (updated.length === 0) return null;
  const token = mintSessionToken(userSession(liveness.userId), SESSION_TTL_SEC, {
    sid: liveness.sid,
  });
  return { token, sid: liveness.sid, expiresAt };
}

/**
 * Revoke the session the presented token belongs to. A `sid` token revokes
 * its row (and so every token re-minted from it); a legacy token gets a
 * denylist row. A token that does not verify is ignored (nothing to revoke).
 */
export async function revokePeSessionToken(
  token: string,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  let claims: ReturnType<typeof verifiedSessionTokenClaims>;
  try {
    claims = verifiedSessionTokenClaims(token);
  } catch {
    return false;
  }
  const userId = claims?.session.requestor?.id;
  if (!claims || !userId) return false;
  if (claims.sid) {
    await db
      .update(peSessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(peSessions.id, claims.sid), isNull(peSessions.revokedAt)));
    return true;
  }
  await db
    .insert(peSessions)
    .values({
      id: legacySessionRowId(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(claims.exp * 1000),
      revokedAt: now,
      revokedReason: reason,
    })
    .onConflictDoNothing();
  return true;
}

/**
 * Kill every token `userId` holds, with or without a `sid`: revoke all rows
 * and set the per-user cutoff to now.
 */
export async function revokeAllPeSessionsForUser(
  userId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(peSessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(peSessions.userId, userId), isNull(peSessions.revokedAt)));
  await db
    .insert(peSessionCutoffs)
    .values({ userId, notBefore: now, reason })
    .onConflictDoUpdate({
      target: peSessionCutoffs.userId,
      set: { notBefore: now, reason },
    });
}
