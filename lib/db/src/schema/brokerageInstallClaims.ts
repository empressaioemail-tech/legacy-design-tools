import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Maps an extension install id to exactly one authenticated user.
 * ADR-005/017 sovereignty: anonymous brief history attaches per-user
 * on sign-in and never pools into a shared asset.
 */
export const brokerageInstallClaims = pgTable(
  "brokerage_install_claims",
  {
    installId: text("install_id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    ownerIdx: index("brokerage_install_claims_owner_user_id_idx").on(
      t.ownerUserId,
    ),
  }),
);

export type BrokerageInstallClaim = typeof brokerageInstallClaims.$inferSelect;
export type NewBrokerageInstallClaim =
  typeof brokerageInstallClaims.$inferInsert;
