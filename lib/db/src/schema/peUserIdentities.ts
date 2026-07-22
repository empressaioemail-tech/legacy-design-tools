import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export type PeOidcProvider = "google" | "microsoft";

/**
 * OIDC provider subject links for Property Explorer users.
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
