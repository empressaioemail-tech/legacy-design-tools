import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-architect "last viewed the inbox" watermark for the design-
 * tools notification surface.
 *
 * One row per `user`-kind requestor id (the same opaque string the
 * session middleware writes into `req.session.requestor.id` and
 * `atom_events.actor.id`). `lastReadAt` is bumped to "now" each time
 * the architect opens the in-app inbox; the API stamps each
 * notification row's `read` flag from this watermark and the FE
 * badge counts events occurring after it as unread.
 *
 * No FK to `users.id` on purpose — the user-profile row is best-
 * effort presentation metadata and may not exist for a freshly-seen
 * requestor; the read-state row needs to be writable independently
 * (mirrors the `atom_events.actor.id → users.id` non-FK rationale).
 */
export const architectNotificationReads = pgTable(
  "architect_notification_reads",
  {
    userId: text("user_id").primaryKey(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export type ArchitectNotificationRead =
  typeof architectNotificationReads.$inferSelect;
export type NewArchitectNotificationRead =
  typeof architectNotificationReads.$inferInsert;
