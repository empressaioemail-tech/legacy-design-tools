import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export type PeOidcProvider = "google" | "microsoft" | "email";

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
