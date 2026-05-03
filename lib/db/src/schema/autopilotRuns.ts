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

export const AUTOPILOT_RUN_STATUS_VALUES = [
  "running",
  "completed",
  "errored",
] as const;
export type AutopilotRunStatus = (typeof AUTOPILOT_RUN_STATUS_VALUES)[number];

export const AUTOPILOT_TRIGGER_VALUES = [
  "manual",
  "auto-on-open",
] as const;
export type AutopilotTrigger = (typeof AUTOPILOT_TRIGGER_VALUES)[number];

export const autopilotRuns = pgTable(
  "autopilot_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    totalSuites: integer("total_suites").notNull().default(0),
    passing: integer("passing").notNull().default(0),
    failing: integer("failing").notNull().default(0),
    flaky: integer("flaky").notNull().default(0),
    autoFixesApplied: integer("auto_fixes_applied").notNull().default(0),
    needsReview: integer("needs_review").notNull().default(0),
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    index("autopilot_runs_started_idx").on(t.startedAt),
    check(
      "autopilot_runs_status_check",
      sql`${t.status} IN ('running', 'completed', 'errored')`,
    ),
    check(
      "autopilot_runs_trigger_check",
      sql`${t.trigger} IN ('manual', 'auto-on-open')`,
    ),
  ],
);

export type AutopilotRun = typeof autopilotRuns.$inferSelect;
export type NewAutopilotRun = typeof autopilotRuns.$inferInsert;
