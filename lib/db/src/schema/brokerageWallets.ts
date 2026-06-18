import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export type BrokerageWalletLedgerKind =
  | "top_up"
  | "compute_debit"
  | "auto_refill"
  | "adjustment"
  | "free_brief";

export type BrokerageSubscriptionTier = "free" | "pro";
export type BrokerageSubscriptionStatus = "active" | "trialing" | "churned";

export const brokerageWallets = pgTable("brokerage_wallets", {
  installId: text("install_id").primaryKey(),
  balanceCents: integer("balance_cents").notNull().default(0),
  autoRefillEnabled: boolean("auto_refill_enabled").notNull().default(false),
  autoRefillFailedAt: timestamp("auto_refill_failed_at", {
    withTimezone: true,
  }),
  freeBriefsUsed: integer("free_briefs_used").notNull().default(0),
  subscriptionTier: text("subscription_tier").$type<BrokerageSubscriptionTier>(),
  subscriptionStatus: text("subscription_status").$type<BrokerageSubscriptionStatus>(),
  subscriptionPeriodEnd: timestamp("subscription_period_end", {
    withTimezone: true,
  }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const brokerageWalletLedger = pgTable(
  "brokerage_wallet_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installId: text("install_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    kind: text("kind").notNull().$type<BrokerageWalletLedgerKind>(),
    reference: text("reference"),
    balanceAfterCents: integer("balance_after_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("brokerage_wallet_ledger_install_created_idx").on(
      t.installId,
      t.createdAt,
    ),
  ],
);
