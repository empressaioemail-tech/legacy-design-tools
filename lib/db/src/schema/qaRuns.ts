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

export const QA_RUN_STATUS_VALUES = [
  "running",
  "passed",
  "failed",
  "errored",
] as const;
export type QaRunStatus = (typeof QA_RUN_STATUS_VALUES)[number];

export const qaRuns = pgTable(
  "qa_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    suiteId: text("suite_id").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    log: text("log").notNull().default(""),
  },
  (t) => [
    index("qa_runs_suite_started_idx").on(t.suiteId, t.startedAt),
    check(
      "qa_runs_status_check",
      sql`${t.status} IN ('running', 'passed', 'failed', 'errored')`,
    ),
  ],
);

export type QaRun = typeof qaRuns.$inferSelect;
export type NewQaRun = typeof qaRuns.$inferInsert;
