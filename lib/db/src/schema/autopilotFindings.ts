import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { autopilotRuns } from "./autopilotRuns";

export const AUTOPILOT_FINDING_CATEGORY_VALUES = [
  "flaky",
  "snapshot",
  "codegen-stale",
  "lint",
  "fixture",
  "app-code",
  "unknown",
] as const;
export type AutopilotFindingCategory =
  (typeof AUTOPILOT_FINDING_CATEGORY_VALUES)[number];

export const AUTOPILOT_FINDING_SEVERITY_VALUES = [
  "info",
  "warning",
  "error",
] as const;
export type AutopilotFindingSeverity =
  (typeof AUTOPILOT_FINDING_SEVERITY_VALUES)[number];

export const AUTOPILOT_FINDING_AUTOFIX_STATUS_VALUES = [
  "auto-fixed",
  "needs-review",
  "skipped",
] as const;
export type AutopilotFindingAutoFixStatus =
  (typeof AUTOPILOT_FINDING_AUTOFIX_STATUS_VALUES)[number];

export const autopilotFindings = pgTable(
  "autopilot_findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    autopilotRunId: uuid("autopilot_run_id")
      .notNull()
      .references(() => autopilotRuns.id, { onDelete: "cascade" }),
    suiteId: text("suite_id").notNull(),
    qaRunId: uuid("qa_run_id"),
    testName: text("test_name"),
    filePath: text("file_path"),
    line: integer("line"),
    errorExcerpt: text("error_excerpt").notNull().default(""),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    autoFixStatus: text("auto_fix_status").notNull(),
    plainSummary: text("plain_summary").notNull().default(""),
    suggestedDiff: text("suggested_diff").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("autopilot_findings_run_idx").on(t.autopilotRunId),
    index("autopilot_findings_suite_idx").on(t.suiteId),
    check(
      "autopilot_findings_category_check",
      sql`${t.category} IN ('flaky', 'snapshot', 'codegen-stale', 'lint', 'fixture', 'app-code', 'unknown')`,
    ),
    check(
      "autopilot_findings_severity_check",
      sql`${t.severity} IN ('info', 'warning', 'error')`,
    ),
    check(
      "autopilot_findings_autofix_check",
      sql`${t.autoFixStatus} IN ('auto-fixed', 'needs-review', 'skipped')`,
    ),
  ],
);

export type AutopilotFinding = typeof autopilotFindings.$inferSelect;
export type NewAutopilotFinding = typeof autopilotFindings.$inferInsert;
