import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * T1-A (2026-10-22): server-side Property Explorer sessions.
 *
 * The session cookie is still the stateless HMAC token minted by
 * `sessionToken.ts`, but every token minted at sign-in now carries a `sid`
 * claim naming one row here. The row is what makes a session revocable
 * (logout, account delete, account merge) and what carries the sliding
 * expiry: `expires_at` moves forward on activity, and a token whose row is
 * revoked or past `expires_at` is treated as signed out even while its own
 * HMAC `exp` is still in the future.
 *
 * Tokens minted before this table existed carry no `sid`. They stay valid
 * until their own 7-day `exp` unless revoked; revoking one writes a row
 * whose id is `legacy:<sha256 of the token>` (a denylist entry).
 */
export const peSessions = pgTable(
  "pe_sessions",
  {
    /** `ps_<hex>` for real sessions, `legacy:<sha256>` for a revoked pre-sid token. */
    id: text("id").primaryKey(),
    /** No FK: a revoked row must outlive an account delete. */
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [index("pe_sessions_user_idx").on(t.userId)],
);

export type PeSession = typeof peSessions.$inferSelect;

/**
 * T1-A: per-user "no token issued before this instant is valid" cutoff.
 * Written by account delete and by the duplicate-account merge (for the
 * merged-away user), so every outstanding token of that user dies at once,
 * including pre-`sid` tokens that have no `pe_sessions` row to revoke.
 * No FK: the cutoff must outlive a deleted `users` row.
 */
export const peSessionCutoffs = pgTable("pe_session_cutoffs", {
  userId: text("user_id").primaryKey(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
});

/**
 * T1-A ruling-3 merge log, one row per merged-away user. `merged_user_id` is
 * the primary key, which is what makes the merge idempotent: a user already
 * merged is never merged again.
 */
export const peAccountMerges = pgTable(
  "pe_account_merges",
  {
    mergedUserId: text("merged_user_id").primaryKey(),
    survivorUserId: text("survivor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    runId: text("run_id").notNull(),
    reason: text("reason").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("pe_account_merges_survivor_idx").on(t.survivorUserId)],
);

/**
 * T1-A: every row the merge touched, with the row exactly as it was before
 * the merge (`before`), so the merge is auditable and reversible by hand.
 * `action`: "moved" (owner column rewritten), "dropped" (a duplicate of a
 * row the survivor already had, deleted), "combined" (folded into the
 * survivor's row, which is logged as "updated" with its own before-image).
 */
export const peAccountMergeRows = pgTable(
  "pe_account_merge_rows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mergedUserId: text("merged_user_id").notNull(),
    tableName: text("table_name").notNull(),
    action: text("action").notNull(),
    before: jsonb("before").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("pe_account_merge_rows_merged_idx").on(t.mergedUserId)],
);
