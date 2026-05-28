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
  | "adjustment";

export const brokerageWallets = pgTable("brokerage_wallets", {
  installId: text("install_id").primaryKey(),
  balanceCents: integer("balance_cents").notNull().default(0),
  autoRefillEnabled: boolean("auto_refill_enabled").notNull().default(false),
  autoRefillFailedAt: timestamp("auto_refill_failed_at", {
    withTimezone: true,
  }),
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
