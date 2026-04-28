import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    projectName: text("project_name").notNull(),
    payload: jsonb("payload").notNull(),
    sheetCount: integer("sheet_count"),
    roomCount: integer("room_count"),
    levelCount: integer("level_count"),
    wallCount: integer("wall_count"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("snapshots_engagement_idx").on(t.engagementId),
    receivedAtIdx: index("snapshots_received_at_idx").on(t.receivedAt),
  }),
);

export const snapshotsRelations = relations(snapshots, ({ one }) => ({
  engagement: one(engagements, {
    fields: [snapshots.engagementId],
    references: [engagements.id],
  }),
}));

export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
