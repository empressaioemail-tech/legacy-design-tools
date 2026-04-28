import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { codeAtomSources } from "./codeAtomSources";

export const codeAtomFetchQueue = pgTable(
  "code_atom_fetch_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => codeAtomSources.id, { onDelete: "cascade" }),
    jurisdictionKey: text("jurisdiction_key").notNull(),
    codeBook: text("code_book").notNull(),
    edition: text("edition").notNull(),
    sectionUrl: text("section_url").notNull(),
    sectionRef: text("section_ref"),
    context: jsonb("context"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  },
  (t) => ({
    statusNextIdx: index("code_atom_fetch_queue_status_next_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    leaseIdx: index("code_atom_fetch_queue_lease_idx").on(
      t.status,
      t.leaseExpiresAt,
    ),
    jurisdictionIdx: index("code_atom_fetch_queue_jurisdiction_idx").on(
      t.jurisdictionKey,
    ),
    urlUnique: uniqueIndex("code_atom_fetch_queue_url_unique").on(
      t.sourceId,
      t.sectionUrl,
    ),
  }),
);

export type CodeAtomFetchQueueItem = typeof codeAtomFetchQueue.$inferSelect;
export type NewCodeAtomFetchQueueItem = typeof codeAtomFetchQueue.$inferInsert;
