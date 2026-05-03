import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const QA_TRIAGE_SOURCE_KIND_VALUES = [
  "autopilot_finding",
  "run",
  "suite_failure",
  "checklist_item",
] as const;
export type QaTriageSourceKind = (typeof QA_TRIAGE_SOURCE_KIND_VALUES)[number];

export const QA_TRIAGE_STATUS_VALUES = ["open", "sent", "done"] as const;
export type QaTriageStatus = (typeof QA_TRIAGE_STATUS_VALUES)[number];

export const QA_TRIAGE_SEVERITY_VALUES = ["info", "warning", "error"] as const;
export type QaTriageSeverity = (typeof QA_TRIAGE_SEVERITY_VALUES)[number];

export const qaTriageItems = pgTable(
  "qa_triage_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceKind: text("source_kind").notNull(),
    // Primary upstream id (autopilot finding id, qa run id, suite id, or
    // checklist item id). `sourceRunId` is an optional secondary id used
    // when the source kind needs both a finding and the run that
    // produced it (so the dashboard can link back).
    sourceId: text("source_id").notNull(),
    sourceRunId: text("source_run_id"),
    suiteId: text("suite_id"),
    title: text("title").notNull(),
    severity: text("severity").notNull().default("error"),
    excerpt: text("excerpt").notNull().default(""),
    suggestedNextStep: text("suggested_next_step").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [
    index("qa_triage_items_status_idx").on(t.status, t.createdAt),
    index("qa_triage_items_source_idx").on(t.sourceKind, t.sourceId),
    check(
      "qa_triage_items_source_kind_check",
      sql`${t.sourceKind} IN ('autopilot_finding', 'run', 'suite_failure', 'checklist_item')`,
    ),
    check(
      "qa_triage_items_status_check",
      sql`${t.status} IN ('open', 'sent', 'done')`,
    ),
    check(
      "qa_triage_items_severity_check",
      sql`${t.severity} IN ('info', 'warning', 'error')`,
    ),
  ],
);

export type QaTriageItem = typeof qaTriageItems.$inferSelect;
export type NewQaTriageItem = typeof qaTriageItems.$inferInsert;
