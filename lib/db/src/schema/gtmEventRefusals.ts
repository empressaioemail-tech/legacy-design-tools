import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";

/**
 * P-100 item 5 — the events this system declined to fabricate.
 *
 * WHY A REFUSAL NEEDS A TABLE. `recordGtmEvent` stamped `consentVersion` from
 * `input.consentVersion ?? null` and none of its fourteen call sites passed
 * one, so 741 of 11,518 rows in production carry a null consent that can
 * never be filled in — consent flags cannot be retrofitted, which is the
 * year-zero rule. The fix is that the writer resolves consent from
 * `gtm_consent` and REFUSES when there is none. But a refusal that leaves no
 * name is how an unattributed non-write becomes unanswerable: the rail simply
 * goes quiet and nothing distinguishes "nobody did this" from "we stopped
 * recording it". So the refusal is itself a durable record.
 *
 * Measured before the change (2026-09-01, production): of the 741 null-consent
 * rows, 459 (62%) belong to installs that DO have a consent row and will now
 * be stamped correctly; 282 (38%, across 94 distinct installs) do not and will
 * land here instead of entering `gtm_events` as a fabricated null.
 *
 * NO FK ON `installId`, matching `gtm_events`: an install id is a
 * client-minted identifier rather than an account, and a refusal for an
 * unknown install is exactly the case worth recording.
 *
 * `reason` IS NOT VALUE-CHECKED IN DDL, for the reason migration 0091 records
 * about `action_id`: the reason vocabulary grows whenever a new refusal
 * condition is added, and a DDL value list would mean a new refusal reason is
 * itself silently refused. The closed set lives at the writer where it is a
 * compile error. What is frozen here is narrower and permanent — the reason
 * may not be the empty string, which is the value a plain NOT NULL admits.
 */

/** The refusal grammar. Closed here; enforced by the compiler at every writer. */
export const GTM_EVENT_REFUSAL_REASONS = ["consent_absent"] as const;

export type GtmEventRefusalReason = (typeof GTM_EVENT_REFUSAL_REASONS)[number];

export const gtmEventRefusals = pgTable(
  "gtm_event_refusals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installId: text("install_id").notNull(),
    eventType: text("event_type").notNull(),
    sourceSurface: text("source_surface").notNull(),
    reason: text("reason").notNull().$type<GtmEventRefusalReason>(),
    refusedAt: timestamp("refused_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("gtm_event_refusals_refused_at_idx").on(t.refusedAt),
    index("gtm_event_refusals_event_type_refused_at_idx").on(
      t.eventType,
      t.refusedAt,
    ),
    check("gtm_event_refusals_reason_chk", sql`${t.reason} <> ''`),
    check("gtm_event_refusals_event_type_chk", sql`${t.eventType} <> ''`),
    check("gtm_event_refusals_install_id_chk", sql`${t.installId} <> ''`),
  ],
);

export type GtmEventRefusal = typeof gtmEventRefusals.$inferSelect;
