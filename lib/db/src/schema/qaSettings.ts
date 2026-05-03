import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tiny key/value store for QA Dashboard runtime settings (e.g. the
 * `autopilot.enabled` toggle). Kept as a generic kv table because the
 * dashboard's settings surface is small enough that a typed columnar
 * schema would be over-engineering.
 */
export const qaSettings = pgTable("qa_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type QaSetting = typeof qaSettings.$inferSelect;
export type NewQaSetting = typeof qaSettings.$inferInsert;
