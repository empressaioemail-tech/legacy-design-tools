import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const QA_CHECKLIST_ITEM_STATUS_VALUES = [
  "pass",
  "fail",
  "skip",
] as const;
export type QaChecklistItemStatus =
  (typeof QA_CHECKLIST_ITEM_STATUS_VALUES)[number];

export const qaChecklistResults = pgTable(
  "qa_checklist_results",
  {
    checklistId: text("checklist_id").notNull(),
    itemId: text("item_id").notNull(),
    status: text("status").notNull(),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.checklistId, t.itemId] }),
    check(
      "qa_checklist_results_status_check",
      sql`${t.status} IN ('pass', 'fail', 'skip')`,
    ),
  ],
);

export type QaChecklistResult = typeof qaChecklistResults.$inferSelect;
export type NewQaChecklistResult = typeof qaChecklistResults.$inferInsert;
