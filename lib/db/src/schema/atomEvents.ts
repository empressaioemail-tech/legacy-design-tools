import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Append-only event log for the Empressa atom framework. Every atom
 * mutation flows through `EventAnchoringService.appendEvent`, which
 * inserts one row here.
 *
 * `chain_hash` is deterministic SHA-256 in A0 and links to the previous
 * event for the same `(entity_type, entity_id)` via `prev_hash`.
 * Cryptographic anchoring (Merkle root, external ledger anchor) replaces
 * the chain hash at M2-C without any schema change.
 *
 * `id` is a ULID-shaped string (Crockford32 time prefix + random suffix)
 * generated client-side so events are time-sortable without an extra
 * column. `actor` and `payload` are JSONB so atoms own their own payload
 * shapes — the framework does not interpret them.
 */
export const atomEvents = pgTable(
  "atom_events",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    actor: jsonb("actor").notNull(),
    payload: jsonb("payload").notNull(),
    prevHash: text("prev_hash"),
    chainHash: text("chain_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    timelineIdx: index("atom_events_timeline_idx").on(
      t.entityType,
      t.entityId,
      t.occurredAt,
    ),
    chainHashUniq: uniqueIndex("atom_events_chain_hash_uniq").on(t.chainHash),
  }),
);

export type AtomEventRow = typeof atomEvents.$inferSelect;
export type NewAtomEventRow = typeof atomEvents.$inferInsert;
