import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { codeAtoms } from "./codeAtoms";

// Placeholder join table. The findings table does not yet exist; this stub
// gives downstream sprints (Sprint A06+) a stable schema target so that
// retrieval/citation code can begin to write atom-anchored findings without
// a follow-on migration. findingId is a free uuid (no FK) until the findings
// table lands.
export const findingsCodeAtoms = pgTable(
  "findings_code_atoms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    findingId: uuid("finding_id").notNull(),
    atomId: uuid("atom_id")
      .notNull()
      .references(() => codeAtoms.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("supports"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    findingIdx: index("findings_code_atoms_finding_idx").on(t.findingId),
    atomIdx: index("findings_code_atoms_atom_idx").on(t.atomId),
  }),
);

export type FindingCodeAtom = typeof findingsCodeAtoms.$inferSelect;
export type NewFindingCodeAtom = typeof findingsCodeAtoms.$inferInsert;
