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

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { sanitizeReturnTo } from "./peReturnTo";
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
  // T1-A: only SUCCESSFUL sends count (sent_at is stamped after Resend
  // accepts the email), so a provider outage never locks a user out.
  const rows = await db
    .select({ createdAt: peMagicLinkTokens.createdAt })
    .from(peMagicLinkTokens)
    .where(
      and(
        eq(peMagicLinkTokens.email, email),
        gte(peMagicLinkTokens.createdAt, windowStart),
        isNotNull(peMagicLinkTokens.sentAt),
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
  | { ok: true; rawToken: string; expiresAt: Date; rowId: string }
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
  const rowId = magicLinkTokenRowId();
  await db.insert(peMagicLinkTokens).values({
    id: rowId,
    email,
    tokenHash: hashMagicLinkToken(rawToken),
    expiresAt,
  });
  return { ok: true, rawToken, expiresAt, rowId };
}

/** T1-A: stamp a row as delivered; only stamped rows count toward the rate limit. */
export async function markMagicLinkSent(
  rowId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(peMagicLinkTokens)
    .set({ sentAt: now })
    .where(eq(peMagicLinkTokens.id, rowId));
}

/** T1-A: a row whose email never left is deleted: it neither counts nor redeems. */
export async function discardUnsentMagicLinkToken(rowId: string): Promise<void> {
  await db
    .delete(peMagicLinkTokens)
    .where(and(eq(peMagicLinkTokens.id, rowId), isNull(peMagicLinkTokens.sentAt)));
}

// ---------------------------------------------------------------------------
// T1-A (2026-10-22): email sign-in with a 6-digit code AND a link, in one
// email. The link opens a confirm page whose button POSTs; a GET never
// consumes anything, so mail scanners and link pre-fetchers cannot burn it.
// ---------------------------------------------------------------------------

/** Code and link share one row and one expiry: 10 minutes. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes allowed per row before it locks. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Salted with the row id so equal codes on two rows never share a hash. */
export function hashEmailCode(rowId: string, code: string): string {
  return createHash("sha256").update(`${rowId}:${code}`, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type StartEmailSignInResult =
  | {
      ok: true;
      rowId: string;
      email: string;
      rawToken: string;
      code: string;
      expiresAt: Date;
      createdAt: Date;
    }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; error: "invalid_email" };

/**
 * Mint one row carrying both a link token and a 6-digit code. The caller
 * sends the email, then calls {@link markMagicLinkSent} (success) or
 * {@link discardUnsentMagicLinkToken} (failure). The raw token and code are
 * returned exactly once and never stored or logged.
 */
export async function startEmailSignIn(
  rawEmail: string,
  opts: { returnTo?: unknown } = {},
  now: Date = new Date(),
): Promise<StartEmailSignInResult> {
  const email = normalizeMagicLinkEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid_email" };
  const rate = await checkMagicLinkRateLimit(email, now);
  if (!rate.ok) {
    return {
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }
  const rowId = magicLinkTokenRowId();
  const rawToken = generateRawToken();
  const code = generateEmailCode();
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
  await db.insert(peMagicLinkTokens).values({
    id: rowId,
    email,
    tokenHash: hashMagicLinkToken(rawToken),
    codeHash: hashEmailCode(rowId, code),
    expiresAt,
    returnTo: sanitizeReturnTo(opts.returnTo),
    createdAt: now,
  });
  return { ok: true, rowId, email, rawToken, code, expiresAt, createdAt: now };
}

/**
 * After a successful send: expire every OLDER outstanding row for this
 * address, so only the newest code and link work. An older link then reads
 * as expired, never as "used".
 */
export async function supersedeOlderEmailSignIns(
  email: string,
  keep: { rowId: string; createdAt: Date },
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(peMagicLinkTokens)
    .set({ expiresAt: now })
    .where(
      and(
        eq(peMagicLinkTokens.email, email),
        isNull(peMagicLinkTokens.consumedAt),
        gt(peMagicLinkTokens.expiresAt, now),
        lt(peMagicLinkTokens.createdAt, keep.createdAt),
        sql`${peMagicLinkTokens.id} <> ${keep.rowId}`,
      ),
    );
}

export type EmailSignInVerifyResult =
  | { ok: true; email: string; returnTo: string }
  | {
      ok: false;
      error:
        | "code_invalid"
        | "code_expired"
        | "too_many_attempts"
        | "link_used"
        | "link_expired";
    };

/**
 * Verify a 6-digit code against the NEWEST delivered row for this address.
 * Each wrong code burns one of {@link EMAIL_CODE_MAX_ATTEMPTS}, counted by an
 * atomic conditional UPDATE so parallel guesses cannot exceed the cap. A
 * right code consumes the row atomically (exactly one sign-in).
 */
export async function verifyEmailCode(
  rawEmail: string,
  rawCode: string,
  now: Date = new Date(),
): Promise<EmailSignInVerifyResult> {
  const email = normalizeMagicLinkEmail(rawEmail);
  const code = rawCode.trim();
  if (!email || !/^[0-9]{6}$/.test(code)) {
    return { ok: false, error: "code_invalid" };
  }

  const [row] = await db
    .select({
      id: peMagicLinkTokens.id,
      expiresAt: peMagicLinkTokens.expiresAt,
      consumedAt: peMagicLinkTokens.consumedAt,
      attempts: peMagicLinkTokens.attempts,
      codeHash: peMagicLinkTokens.codeHash,
      returnTo: peMagicLinkTokens.returnTo,
    })
    .from(peMagicLinkTokens)
    .where(
      and(
        eq(peMagicLinkTokens.email, email),
        isNotNull(peMagicLinkTokens.codeHash),
        isNotNull(peMagicLinkTokens.sentAt),
      ),
    )
    .orderBy(desc(peMagicLinkTokens.createdAt))
    .limit(1);

  if (!row || !row.codeHash) return { ok: false, error: "code_expired" };
  if (row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: "code_expired" };
  }
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return { ok: false, error: "too_many_attempts" };
  }

  if (!hashesEqual(hashEmailCode(row.id, code), row.codeHash)) {
    const bumped = await db
      .update(peMagicLinkTokens)
      .set({ attempts: sql`${peMagicLinkTokens.attempts} + 1` })
      .where(
        and(
          eq(peMagicLinkTokens.id, row.id),
          lt(peMagicLinkTokens.attempts, EMAIL_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning({ attempts: peMagicLinkTokens.attempts });
    const attempts = bumped[0]?.attempts ?? EMAIL_CODE_MAX_ATTEMPTS;
    return {
      ok: false,
      error:
        attempts >= EMAIL_CODE_MAX_ATTEMPTS ? "too_many_attempts" : "code_invalid",
    };
  }

  const consumed = await db
    .update(peMagicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(peMagicLinkTokens.id, row.id),
        isNull(peMagicLinkTokens.consumedAt),
        gt(peMagicLinkTokens.expiresAt, now),
        lt(peMagicLinkTokens.attempts, EMAIL_CODE_MAX_ATTEMPTS),
      ),
    )
    .returning({ id: peMagicLinkTokens.id });
  if (consumed.length === 0) return { ok: false, error: "code_expired" };
  return { ok: true, email, returnTo: sanitizeReturnTo(row.returnTo) };
}

export type EmailLinkStatus = {
  status: "valid" | "used" | "expired";
  returnTo: string;
};

/** Read-only look at a link token. Never consumes, never counts an attempt. */
export async function peekEmailLinkToken(
  rawToken: unknown,
  now: Date = new Date(),
): Promise<EmailLinkStatus> {
  if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > 512) {
    return { status: "expired", returnTo: "/" };
  }
  const [row] = await db
    .select({
      expiresAt: peMagicLinkTokens.expiresAt,
      consumedAt: peMagicLinkTokens.consumedAt,
      returnTo: peMagicLinkTokens.returnTo,
    })
    .from(peMagicLinkTokens)
    .where(eq(peMagicLinkTokens.tokenHash, hashMagicLinkToken(rawToken)))
    .limit(1);
  if (!row) return { status: "expired", returnTo: "/" };
  const returnTo = sanitizeReturnTo(row.returnTo);
  if (row.consumedAt) return { status: "used", returnTo };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: "expired", returnTo };
  return { status: "valid", returnTo };
}

/** Redeem a link token (POST only). Same atomic single-use guard as the legacy path. */
export async function consumeEmailLinkToken(
  rawToken: unknown,
  now: Date = new Date(),
): Promise<EmailSignInVerifyResult> {
  const consumed = await consumeMagicLinkToken(rawToken, now);
  if (!consumed.ok) {
    return {
      ok: false,
      error: consumed.error === "already_used" ? "link_used" : "link_expired",
    };
  }
  const [row] = await db
    .select({ returnTo: peMagicLinkTokens.returnTo })
    .from(peMagicLinkTokens)
    .where(eq(peMagicLinkTokens.tokenHash, hashMagicLinkToken(rawToken as string)))
    .limit(1);
  return { ok: true, email: consumed.email, returnTo: sanitizeReturnTo(row?.returnTo) };
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
