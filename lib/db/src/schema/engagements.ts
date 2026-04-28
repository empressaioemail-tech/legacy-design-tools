import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { snapshots } from "./snapshots";

export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull().unique(),
    jurisdiction: text("jurisdiction"),
    address: text("address"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    nameLowerIdx: index("engagements_name_lower_idx").on(t.nameLower),
  }),
);

export const engagementsRelations = relations(engagements, ({ many }) => ({
  snapshots: many(snapshots),
}));

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
