import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * R1 paywall (LOCK 2026-07-29) — server-enforced signed-in-free chat
 * counter. One row per (ownerUserId, parcelNodeId); `count` is bumped by an
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING`
 * (permit_counters precedent) so concurrent messages serialize on the row
 * lock and can never exceed the free allowance. Entitled users
 * (Pro / property unlocked / dev bypass) are never counted.
 */
export const peChatMessageCounts = pgTable(
  "pe_chat_message_counts",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parcelNodeId: text("parcel_node_id").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerUserId, t.parcelNodeId] })],
);

export type PeChatMessageCount = typeof peChatMessageCounts.$inferSelect;
