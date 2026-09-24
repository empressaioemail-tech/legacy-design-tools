import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * P-413 — durable outbox for Smart Site lifecycle events (E1–E6).
 *
 * A row is the intent to tell GoHighLevel and Meta that something already
 * happened in the product. The user's action commits first; this row is
 * written in the same request so a GHL/Meta failure cannot lose the event
 * and cannot delay the user. The worker sends and retries.
 *
 * `id` is the Meta `event_id` (and the `lifecycleEventId` returned to the
 * browser). `idempotency_key` is unique so a retry of the action cannot
 * enqueue a second send.
 */

export type PeLifecycleOutboxStatus = "pending" | "sent" | "failed";

export type PeLifecycleOutboxPayload = Record<string, unknown>;

export const peLifecycleOutbox = pgTable(
  "pe_lifecycle_outbox",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    email: text("email").notNull(),
    payloadJson: jsonb("payload_json")
      .$type<PeLifecycleOutboxPayload>()
      .notNull()
      .default({}),
    status: text("status").notNull().$type<PeLifecycleOutboxStatus>().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pe_lifecycle_outbox_idempotency_uidx").on(t.idempotencyKey),
    index("pe_lifecycle_outbox_status_created_idx").on(t.status, t.createdAt),
    index("pe_lifecycle_outbox_owner_idx").on(t.ownerUserId, t.createdAt),
    check("pe_lifecycle_outbox_event_type_chk", sql`${t.eventType} <> ''`),
    check("pe_lifecycle_outbox_email_chk", sql`${t.email} <> ''`),
    check(
      "pe_lifecycle_outbox_status_chk",
      sql`${t.status} IN ('pending', 'sent', 'failed')`,
    ),
  ],
);

export type PeLifecycleOutbox = typeof peLifecycleOutbox.$inferSelect;
export type NewPeLifecycleOutbox = typeof peLifecycleOutbox.$inferInsert;
