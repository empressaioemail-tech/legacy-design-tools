import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable factory/onboarding run row for the County Manifest LIVE panel.
 *
 * One row per run, updated at stage boundaries. Distinct from `report_run`
 * (plan-review pipeline) and the honestly-empty `operatorRunState` warming
 * projection — this is the county-factory run log the mockup LIVE tab needs.
 *
 * `resource_key` slot semantics live in `manifest_slot_reservation` /
 * `manifest_slot_queue`; this row carries `holdsHeavySlot` as a denormalized
 * flag for fast LIVE queries. A parallel Neon advisory-lock lane can layer on
 * without schema changes — see `manifestObservability.ts`.
 */
export const manifestRun = pgTable(
  "manifest_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lane: text("lane").notNull(),
    job: text("job").notNull(),
    targetFips: text("target_fips"),
    targetCity: text("target_city"),
    cohort: text("cohort"),
    scopeLabel: text("scope_label"),
    stage: text("stage").notNull(),
    /** `running` | `succeeded` | `failed` | `cancelled`. */
    status: text("status").notNull().default("running"),
    outcome: text("outcome"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    itemsDone: integer("items_done"),
    itemsTotal: integer("items_total"),
    holdsHeavySlot: boolean("holds_heavy_slot").notNull().default(false),
    artifactPath: text("artifact_path"),
    computeSeconds: numeric("compute_seconds", { precision: 12, scale: 3 }),
    dbSeconds: numeric("db_seconds", { precision: 12, scale: 3 }),
    egressBytes: bigint("egress_bytes", { mode: "number" }),
    externalApiCalls: integer("external_api_calls"),
    humanMinutes: numeric("human_minutes", { precision: 8, scale: 2 }),
    costUsd: numeric("cost_usd", { precision: 10, scale: 2 }),
    /**
     * `acquisition` | `rewarm` | `verify` | `score` | `other`. Re-warm runs
     * MUST use `rewarm` so `countsTowardCommitment` stays false per operator
     * ruling 2026-08-08.
     */
    runClass: text("run_class").notNull().default("other"),
    /** True only for the first successful acquisition pass per jurisdiction. */
    countsTowardCommitment: boolean("counts_toward_commitment")
      .notNull()
      .default(false),
    notes: text("notes"),
  },
  (t) => [
    index("manifest_run_status_heartbeat_idx").on(t.status, t.heartbeatAt),
    index("manifest_run_lane_started_idx").on(t.lane, t.startedAt),
    index("manifest_run_target_fips_idx").on(t.targetFips),
    uniqueIndex("manifest_run_active_heavy_slot_uniq")
      .on(t.holdsHeavySlot)
      .where(
        sql`${t.holdsHeavySlot} = true AND ${t.status} = 'running'`,
      ),
    check(
      "manifest_run_status_check",
      sql`${t.status} IN ('running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "manifest_run_run_class_check",
      sql`${t.runClass} IN ('acquisition', 'rewarm', 'verify', 'score', 'other')`,
    ),
  ],
);

export type ManifestRunRow = typeof manifestRun.$inferSelect;
export type ManifestRunInsert = typeof manifestRun.$inferInsert;
