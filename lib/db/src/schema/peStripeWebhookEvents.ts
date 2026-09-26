import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

/** Append-only record of a Stripe webhook delivery (P-480). */
export const peStripeWebhookEvents = pgTable(
  "pe_stripe_webhook_events",
  {
    stripeEventId: text("stripe_event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    checkoutSessionId: text("checkout_session_id"),
    amountTotalCents: integer("amount_total_cents"),
    currency: text("currency"),
    livemode: boolean("livemode").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    outcome: text("outcome").notNull(),
  },
  (t) => [
    index("pe_stripe_webhook_events_owner_user_id_received_at_idx").on(
      t.ownerUserId,
      t.receivedAt,
    ),
    check(
      "pe_stripe_webhook_events_stripe_event_id_chk",
      sql`${t.stripeEventId} <> ''`,
    ),
    check(
      "pe_stripe_webhook_events_event_type_chk",
      sql`${t.eventType} <> ''`,
    ),
    check(
      "pe_stripe_webhook_events_outcome_chk",
      sql`${t.outcome} <> ''`,
    ),
  ],
);

export type PeStripeWebhookEvent = typeof peStripeWebhookEvents.$inferSelect;
