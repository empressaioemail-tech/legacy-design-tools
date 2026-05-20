import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * L3 — `deliverable-letter` atom persistence (Cortex Lane C.4 / C.4.3).
 *
 * One row per deliverable letter: the comment-response letter as a
 * classified atom. The `sections` JSONB column carries the ordered
 * `LetterSection[]` — each `{ kind, heading, content, provenance }`,
 * where `provenance` names the L1 / L2 / finding / adjudication atoms
 * that fed the section. Section-targeted endpoints address sections by
 * their zero-based index into this array.
 *
 * Lifecycle: `draft → sent`. A letter is sendable only when the
 * `cover` / `intro` / `signature` section kinds are each present
 * (the engine `deliverableLetterCompleteness()` helper is the source
 * of truth); `POST .../send` gates on it.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L3. Atom shape: `DELIVERABLE_LETTER_SCHEMA` in
 * `@workspace/atoms-l-surface`.
 */

export const DELIVERABLE_LETTER_STATUS_VALUES = ["draft", "sent"] as const;
export type DeliverableLetterStatusValue =
  (typeof DELIVERABLE_LETTER_STATUS_VALUES)[number];

export const deliverableLetters = pgTable(
  "deliverable_letters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Human letter title. */
    title: text("title").notNull(),
    /** Lifecycle status. */
    status: text("status").notNull().default("draft"),
    /** Client actor receiving the letter (ADR-015). Null while drafting. */
    recipientActorId: text("recipient_actor_id"),
    /**
     * Ordered `LetterSection[]`. Each entry is
     * `{ kind, heading, content, provenance }`; array order is the
     * letter order and is what the section-index endpoints address.
     */
    sections: jsonb("sections").notNull().default(sql`'[]'::jsonb`),
    /** Architect / staff member who authored the letter (ADR-015). */
    actorId: text("actor_id"),
    /** Actor accountable; may differ from `actorId` for delegation. */
    principalActorId: text("principal_actor_id"),
    /** Timestamp the letter entered `sent`. Null while `draft`. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("deliverable_letters_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — the
     * drizzle CHECK builder cannot interpolate a TS array; keep in
     * lock-step with `DELIVERABLE_LETTER_STATUS_VALUES`.
     */
    statusCheck: check(
      "deliverable_letters_status_check",
      sql`${t.status} IN ('draft', 'sent')`,
    ),
  }),
);

export type DeliverableLetter = typeof deliverableLetters.$inferSelect;
export type NewDeliverableLetter = typeof deliverableLetters.$inferInsert;
