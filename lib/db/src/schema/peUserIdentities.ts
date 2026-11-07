import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * "microsoft" stays in the union for existing identities and the MCP
 * connector login only; the app no longer offers it (T1 ruling 2, 2026-10-22).
 * A future "apple" provider drops in here without schema changes.
 */
export type PeOidcProvider = "google" | "microsoft" | "email" | "apple";

/**
 * Provider subject links for Property Explorer users — OIDC providers
 * (google/microsoft) plus, since P-112, "email" for magic-link sign-in.
 * "email" has no external identity provider or subject of its own: the
 * verified address IS the durable identifier, so `subject` is set to the
 * same normalized email as the `email` column. This lets magic-link sign-in
 * reuse `upsertPeOidcIdentity` unchanged (provider: "email", subject:
 * <normalized email>) so a magic-link account is created and found through
 * the exact same path as an OAuth account — same `users` row shape, same
 * entitlement bootstrap, same GHL-new-signup hook.
 *
 * One row per (provider, subject); upserted on session-exchange.
 */
export const peUserIdentities = pgTable(
  "pe_user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().$type<PeOidcProvider>(),
    subject: text("subject").notNull(),
    email: text("email"),
    /**
     * T1-A (2026-10-22): true only when the email on this identity is
     * PROVEN: Google's email_verified claim, or a redeemed email code/link.
     * Account linking and the duplicate-account merge key on verified
     * emails only, on BOTH sides, so an unverified address can never pull a
     * stranger's account into its own.
     */
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pe_user_identities_provider_subject_uidx").on(
      t.provider,
      t.subject,
    ),
    index("pe_user_identities_user_idx").on(t.userId),
  ],
);

export type PeUserIdentity = typeof peUserIdentities.$inferSelect;
