import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const codeAtomSources = pgTable("code_atom_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceName: text("source_name").notNull().unique(),
  label: text("label").notNull(),
  sourceType: text("source_type").notNull(),
  licenseType: text("license_type").notNull(),
  baseUrl: text("base_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type CodeAtomSource = typeof codeAtomSources.$inferSelect;
export type NewCodeAtomSource = typeof codeAtomSources.$inferInsert;
