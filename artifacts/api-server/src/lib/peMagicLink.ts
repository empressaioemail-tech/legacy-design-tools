/**
 * P-112 email leg — magic-link token lifecycle (mint, hash, rate-limit,
 * consume). No password anywhere in this flow (ruling addendum,
 * `_decisions/2026-09-04_p112_auth_options_ruling.md`).
 *
 * Token shape: 256 bits of `crypto.randomBytes`, base64url-encoded. The raw
 * token is returned to the caller exactly once (to be emailed) and never
 * stored — only its SHA-256 hex digest goes in `pe_magic_link_tokens`,
 * mirroring the hash-then-compare precedent `peAuth.ts`'s
 * `timingSafeStringEqual` already set for the session-exchange bearer
 * secret. Nothing in this module logs the raw token.
 *
 * Expiry: 20 minutes. Chosen as the midpoint of the commonly-used 15-30
 * minute range for email-delivered auth links — long enough to absorb
 * realistic mail-delivery/inbox-checking latency, short enough that a
 * leaked or forwarded link stops being useful quickly. Deliberately far
 * shorter than the 7-day PE session cookie it grants: the link is a
 * one-time door, not the session itself.
 *
 * Rate limit: at most 3 send requests per normalized email address per
 * rolling 15-minute window, counted directly off this table's own rows (no
 * second table needed). Generous enough for legitimate retries (a mistyped
 * address corrected, a slow inbox, a spam-folder check) while capping the
 * nuisance ceiling an attacker could aim at a stranger's inbox at 12/hour.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, gte, isNull } from "drizzle-orm";
import { db, peMagicLinkTokens, type PeMagicLinkToken } from "@workspace/db";

export const MAGIC_LINK_TTL_MS = 20 * 60 * 1000;
export const MAGIC_LINK_RATE_LIMIT_MAX = 3;
export const MAGIC_LINK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Token wire length before hashing — 256-bit random value, base64url. */
const TOKEN_BYTES = 32;

export function normalizeMagicLinkEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Deliberately loose — a real deliverability check happens by virtue of
  // the email either arriving or not; this just rejects obvious garbage
  // before we mint a token and call Resend.
  if (!trimmed || trimmed.length > 254 || !trimmed.includes("@")) return null;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed;
}

export function hashMagicLinkToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function generateRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function magicLinkTokenRowId(): string {
  return `pmlt_${randomBytes(12).toString("hex")}`;
}

export type MagicLinkRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Count this email's token rows created inside the rolling window. Rejects
 * the request (without minting a row) once the cap is hit, and reports how
 * long until the oldest row in the window ages out.
 */
export async function checkMagicLinkRateLimit(
  email: string,
  now: Date = new Date(),
): Promise<MagicLinkRateLimitResult> {
  const windowStart = new Date(now.getTime() - MAGIC_LINK_RATE_LIMIT_WINDOW_MS);
  const rows = await db
    .select({ createdAt: peMagicLinkTokens.createdAt })
    .from(peMagicLinkTokens)
    .where(
      and(
        eq(peMagicLinkTokens.email, email),
        gte(peMagicLinkTokens.createdAt, windowStart),
      ),
    );
  if (rows.length < MAGIC_LINK_RATE_LIMIT_MAX) {
    return { ok: true };
  }
  const oldest = rows.reduce(
    (min: Date, r: { createdAt: Date }) => (r.createdAt < min ? r.createdAt : min),
    rows[0]!.createdAt,
  );
  const retryAfterMs =
    oldest.getTime() + MAGIC_LINK_RATE_LIMIT_WINDOW_MS - now.getTime();
  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export type CreateMagicLinkTokenResult =
  | { ok: true; rawToken: string; expiresAt: Date }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; error: "invalid_email" };

/**
 * Mint + store a new magic-link token for `email` after checking the rate
 * limit. Returns the RAW token (caller must email it and must not log it or
 * return it in any API response).
 */
export async function createMagicLinkToken(
  rawEmail: string,
  now: Date = new Date(),
): Promise<CreateMagicLinkTokenResult> {
  const email = normalizeMagicLinkEmail(rawEmail);
  if (!email) {
    return { ok: false, error: "invalid_email" };
  }
  const rate = await checkMagicLinkRateLimit(email, now);
  if (!rate.ok) {
    return {
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }
  const rawToken = generateRawToken();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
  await db.insert(peMagicLinkTokens).values({
    id: magicLinkTokenRowId(),
    email,
    tokenHash: hashMagicLinkToken(rawToken),
    expiresAt,
  });
  return { ok: true, rawToken, expiresAt };
}

export type ConsumeMagicLinkTokenResult =
  | { ok: true; email: string }
  | { ok: false; error: "malformed" }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "expired" }
  | { ok: false; error: "already_used" };

/**
 * Redeem a raw token exactly once. Uses a single atomic
 * `UPDATE ... WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > now()`
 * so two concurrent redemptions of the same link race safely — only one can
 * ever flip `consumedAt`. When the atomic update affects zero rows, a
 * follow-up read distinguishes the honest reason (never existed, expired,
 * or already used) so the caller can report a specific, non-generic error.
 */
export async function consumeMagicLinkToken(
  rawToken: unknown,
  now: Date = new Date(),
): Promise<ConsumeMagicLinkTokenResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > 512) {
    return { ok: false, error: "malformed" };
  }
  const tokenHash = hashMagicLinkToken(rawToken);

  const consumed = await db
    .update(peMagicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(peMagicLinkTokens.tokenHash, tokenHash),
        isNull(peMagicLinkTokens.consumedAt),
        gt(peMagicLinkTokens.expiresAt, now),
      ),
    )
    .returning({ email: peMagicLinkTokens.email });

  const row = consumed[0];
  if (row) {
    return { ok: true, email: row.email };
  }

  // Nothing flipped — disambiguate why, for an honest (not generic) error.
  const [existing] = await db
    .select({
      expiresAt: peMagicLinkTokens.expiresAt,
      consumedAt: peMagicLinkTokens.consumedAt,
    })
    .from(peMagicLinkTokens)
    .where(eq(peMagicLinkTokens.tokenHash, tokenHash))
    .limit(1);

  if (!existing) {
    return { ok: false, error: "not_found" };
  }
  if (existing.consumedAt) {
    return { ok: false, error: "already_used" };
  }
  return { ok: false, error: "expired" };
}

/** Type guard used by tests that assert on raw table rows. */
export function isPeMagicLinkToken(row: unknown): row is PeMagicLinkToken {
  return typeof row === "object" && row !== null && "tokenHash" in row;
}
