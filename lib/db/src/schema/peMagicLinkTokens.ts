import {
  integer,
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * P-112 email leg — magic-link sign-in tokens for Property Explorer.
 *
 * Ruling `_decisions/2026-09-04_p112_auth_options_ruling.md` (doc_repo),
 * 2026-09-04 addendum: magic link, ruled, no password anywhere in this flow.
 *
 * A row is minted per "send me a link" request and consumed at most once by
 * the verify route. Never stores the raw token — only its SHA-256 hash
 * (`tokenHash`), matching the hash-then-compare precedent this same route
 * family already uses for the session-exchange bearer secret
 * (`peAuth.ts`'s `timingSafeStringEqual`). The raw token exists only inside
 * the emailed link and the request body of the one verify call that
 * redeems it — never logged, never returned in any API response.
 *
 * `consumedAt` is the single-use guard: null = unredeemed, non-null = spent.
 * The verify path flips it with an atomic
 * `UPDATE ... WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > now()`
 * so two concurrent redemptions of the same link (double-click, email
 * link-scanner prefetch) can never both succeed.
 *
 * `email` is indexed (not unique — the same address can have several
 * outstanding/expired/consumed rows over time) so the request route can
 * count recent rows for that address to enforce the per-email rate limit
 * without a second table.
 */
export const peMagicLinkTokens = pgTable(
  "pe_magic_link_tokens",
  {
    id: text("id").primaryKey(),
    /** Normalized (trimmed, lowercased) recipient address. */
    email: text("email").notNull(),
    /** SHA-256 hex digest of the raw token. Never the raw token itself. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null = unredeemed. Set exactly once, by the atomic consume update. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * T1-A: SHA-256 of the 6-digit code sent in the same email (salted with
     * the row id). Null on rows minted by the legacy link-only route.
     */
    codeHash: text("code_hash"),
    /** Wrong-code attempts against this row; 5 locks the code. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * Set once Resend accepted the email. The rate limit counts only rows
     * with a sent_at, so a failed send never uses up the user's allowance.
     */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Validated same-site relative path to land on after sign-in. */
    returnTo: text("return_to"),
  },
  (t) => [
    uniqueIndex("pe_magic_link_tokens_token_hash_uidx").on(t.tokenHash),
    index("pe_magic_link_tokens_email_created_idx").on(t.email, t.createdAt),
  ],
);

export type PeMagicLinkToken = typeof peMagicLinkTokens.$inferSelect;
export type NewPeMagicLinkToken = typeof peMagicLinkTokens.$inferInsert;
