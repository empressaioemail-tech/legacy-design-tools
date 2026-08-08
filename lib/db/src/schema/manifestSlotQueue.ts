import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manifestRun } from "./manifestRun";

/**
 * Ordered wait queue behind a manifest slot reservation.
 *
 * Strictly ordered by `queuePosition` among active entries
 * (`dequeuedAt IS NULL`). Nothing in the queue can start until the slot
 * holder releases — the mockup LIVE panel's "3 queued behind" card.
 */
export const manifestSlotQueue = pgTable(
  "manifest_slot_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceKey: text("resource_key").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => manifestRun.id, { onDelete: "cascade" }),
    queuePosition: integer("queue_position").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dequeuedAt: timestamp("dequeued_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("manifest_slot_queue_active_position_uniq")
      .on(t.resourceKey, t.queuePosition)
      .where(sql`${t.dequeuedAt} IS NULL`),
    uniqueIndex("manifest_slot_queue_active_run_uniq")
      .on(t.resourceKey, t.runId)
      .where(sql`${t.dequeuedAt} IS NULL`),
    index("manifest_slot_queue_resource_enqueued_idx").on(
      t.resourceKey,
      t.enqueuedAt,
    ),
  ],
);

export type ManifestSlotQueueRow = typeof manifestSlotQueue.$inferSelect;
export type ManifestSlotQueueInsert = typeof manifestSlotQueue.$inferInsert;
