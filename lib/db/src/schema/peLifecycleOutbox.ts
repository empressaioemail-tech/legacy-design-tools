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
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { affiliatePartner } from "./ssContact";

/**
 * P-413 — durable outbox for Smart Site lifecycle events.
 * P-492 — three independent legs (local, resend, meta), an attempt cap and a
 * counted `dead` state, claimed by a scheduled drain with SKIP LOCKED.
 *
 * A row is the intent to record and announce something that already happened
 * in the product. The user's action commits first; this row is written in the
 * same request so a send failure cannot lose the event and cannot delay the
 * user.
 *
 * `id` is the Meta `event_id` (and the `lifecycleEventId` returned to the
 * browser). `idempotency_key` is unique so a retry of the action cannot
 * enqueue a second send.
 *
 * A row belongs to exactly one subject: a Smart Site user (`owner_user_id`) or
 * an affiliate (`affiliate_partner_id`).
 *
 * `status` is the aggregate of the three legs: `sent` when every leg is sent
 * or skipped, `dead` when a leg hit the attempt cap and the rest are terminal,
 * otherwise `pending` / `failed`.
 */

export type PeLifecycleOutboxStatus = "pending" | "sent" | "failed" | "dead";

export type PeLifecycleLegStatus =
  | "pending"
  | "sent"
  | "failed"
  | "dead"
  | "skipped";

export type PeLifecycleOutboxPayload = Record<string, unknown>;

export const peLifecycleOutbox = pgTable(
  "pe_lifecycle_outbox",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    affiliatePartnerId: uuid("affiliate_partner_id").references(
      () => affiliatePartner.id,
      { onDelete: "cascade" },
    ),
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
    localStatus: text("local_status")
      .notNull()
      .$type<PeLifecycleLegStatus>()
      .default("pending"),
    localAttempts: integer("local_attempts").notNull().default(0),
    localError: text("local_error"),
    resendStatus: text("resend_status")
      .notNull()
      .$type<PeLifecycleLegStatus>()
      .default("pending"),
    resendAttempts: integer("resend_attempts").notNull().default(0),
    resendError: text("resend_error"),
    metaStatus: text("meta_status")
      .notNull()
      .$type<PeLifecycleLegStatus>()
      .default("pending"),
    metaAttempts: integer("meta_attempts").notNull().default(0),
    metaError: text("meta_error"),
    /** Event data the local projection derived (e.g. `previous_plan`). */
    resendEventJson: jsonb("resend_event_json").$type<PeLifecycleOutboxPayload>(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Lease: a drain owns the row until this time. */
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pe_lifecycle_outbox_idempotency_uidx").on(t.idempotencyKey),
    index("pe_lifecycle_outbox_status_created_idx").on(t.status, t.createdAt),
    index("pe_lifecycle_outbox_owner_idx").on(t.ownerUserId, t.createdAt),
    index("pe_lifecycle_outbox_due_idx").on(t.status, t.nextAttemptAt),
    check("pe_lifecycle_outbox_event_type_chk", sql`${t.eventType} <> ''`),
    check("pe_lifecycle_outbox_email_chk", sql`${t.email} <> ''`),
    check(
      "pe_lifecycle_outbox_status_chk",
      sql`${t.status} IN ('pending', 'sent', 'failed', 'dead')`,
    ),
    check(
      "pe_lifecycle_outbox_local_status_chk",
      sql`${t.localStatus} IN ('pending', 'sent', 'failed', 'dead', 'skipped')`,
    ),
    check(
      "pe_lifecycle_outbox_resend_status_chk",
      sql`${t.resendStatus} IN ('pending', 'sent', 'failed', 'dead', 'skipped')`,
    ),
    check(
      "pe_lifecycle_outbox_meta_status_chk",
      sql`${t.metaStatus} IN ('pending', 'sent', 'failed', 'dead', 'skipped')`,
    ),
    check(
      "pe_lifecycle_outbox_subject_chk",
      sql`(${t.ownerUserId} IS NULL) <> (${t.affiliatePartnerId} IS NULL)`,
    ),
  ],
);

export type PeLifecycleOutbox = typeof peLifecycleOutbox.$inferSelect;
export type NewPeLifecycleOutbox = typeof peLifecycleOutbox.$inferInsert;
