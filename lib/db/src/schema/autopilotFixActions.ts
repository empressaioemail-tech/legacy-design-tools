import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { autopilotRuns } from "./autopilotRuns";
import { autopilotFindings } from "./autopilotFindings";

export const autopilotFixActions = pgTable(
  "autopilot_fix_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    autopilotRunId: uuid("autopilot_run_id")
      .notNull()
      .references(() => autopilotRuns.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").references(() => autopilotFindings.id, {
      onDelete: "set null",
    }),
    fixerId: text("fixer_id").notNull(),
    suiteId: text("suite_id").notNull(),
    command: text("command").notNull(),
    filesChanged: text("files_changed").notNull().default("[]"),
    success: boolean("success").notNull().default(false),
    log: text("log").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("autopilot_fix_actions_run_idx").on(t.autopilotRunId)],
);

export type AutopilotFixAction = typeof autopilotFixActions.$inferSelect;
export type NewAutopilotFixAction = typeof autopilotFixActions.$inferInsert;
