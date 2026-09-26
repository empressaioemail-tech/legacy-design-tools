import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { peStripeWebhookEvents } from "./peStripeWebhookEvents";
import type {
  PeAccessTier,
  PeBillingInterval,
  PeEntitlementSource,
  PeSubscriptionTier,
} from "./peUserEntitlements";

/** Prior pe_user_entitlements state superseded by a Stripe webhook (P-480). */
export const peUserEntitlementHistory = pgTable(
  "pe_user_entitlement_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    accessTier: text("access_tier").notNull().$type<PeAccessTier>(),
    devRole: boolean("dev_role").notNull(),
    entitlementSource: text("entitlement_source").$type<PeEntitlementSource>(),
    stripeCustomerId: text("stripe_customer_id"),
    subscriptionTier: text("subscription_tier").$type<PeSubscriptionTier>(),
    seatsPurchased: integer("seats_purchased"),
    billingInterval: text("billing_interval").$type<PeBillingInterval>(),
    supersededAt: timestamp("superseded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    stripeEventId: text("stripe_event_id")
      .notNull()
      .references(() => peStripeWebhookEvents.stripeEventId, {
        onDelete: "restrict",
        name: "pe_user_entitlement_history_stripe_event_id_pe_stripe_webhook_e",
      }),
  },
  (t) => [
    index("pe_user_entitlement_history_owner_user_id_superseded_at_idx").on(
      t.ownerUserId,
      t.supersededAt,
    ),
    check(
      "pe_user_entitlement_history_billing_interval_chk",
      sql`${t.billingInterval} IS NULL OR ${t.billingInterval} IN ('month', 'year')`,
    ),
  ],
);

export type PeUserEntitlementHistoryRow =
  typeof peUserEntitlementHistory.$inferSelect;
