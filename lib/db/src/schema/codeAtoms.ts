import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  vector,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { codeAtomSources } from "./codeAtomSources";

export const codeAtoms = pgTable(
  "code_atoms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => codeAtomSources.id, { onDelete: "cascade" }),
    jurisdictionKey: text("jurisdiction_key").notNull(),
    codeBook: text("code_book").notNull(),
    edition: text("edition").notNull(),
    sectionNumber: text("section_number"),
    sectionTitle: text("section_title"),
    parentSection: text("parent_section"),
    body: text("body").notNull(),
    bodyHtml: text("body_html"),
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    contentHash: text("content_hash").notNull().unique("code_atoms_content_hash_unique"),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    jurisdictionIdx: index("code_atoms_jurisdiction_idx").on(t.jurisdictionKey),
    jurisdictionBookIdx: index("code_atoms_jurisdiction_book_idx").on(
      t.jurisdictionKey,
      t.codeBook,
    ),
    sourceIdx: index("code_atoms_source_idx").on(t.sourceId),
    sectionIdx: index("code_atoms_section_idx").on(
      t.jurisdictionKey,
      t.codeBook,
      t.sectionNumber,
    ),
  }),
);

export const codeAtomsRelations = relations(codeAtoms, ({ one }) => ({
  source: one(codeAtomSources, {
    fields: [codeAtoms.sourceId],
    references: [codeAtomSources.id],
  }),
}));

export type CodeAtom = typeof codeAtoms.$inferSelect;
export type NewCodeAtom = typeof codeAtoms.$inferInsert;
