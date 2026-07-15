import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Durable plan-review report-run STATE — cross-instance-correct status.
 *
 * Why a real table (not the in-process Maps it replaces): the plan-review
 * report-run pipeline (`artifacts/api-server/src/routes/planReviewBff.ts`)
 * tracked in-flight / failure / inline-result state in THREE instance-local
 * Maps (`inFlightReports`, `lastReportRunFailure`, `reportResultCache`). On
 * multi-instance Cloud Run a status GET that lands on a different instance
 * than the one that ran the job saw `not-run` even though a sibling instance
 * held the real running/failed/done record. The #249 watchdog bounded a
 * forever-`running` state but did NOT fix cross-instance visibility. Moving
 * run state into shared Postgres makes the status GET correct regardless of
 * which instance answers it. Mirrors the `finding_runs` reasoning
 * (lib/db/src/schema/findingRuns.ts) — "a multi-instance deployment needs a
 * coherent view across processes".
 *
 * Keyed (engagement_id, report_type): this is exactly the pair the status
 * GET queries and the pair every in-memory key (`${engagementId}:${type}`)
 * was built from. History is NOT needed — the in-memory model it replaces
 * kept only the LATEST running record and LATEST failure per key, never a
 * log — so a single upsert-target row per pair is the minimal correct shape.
 * Idempotent upserts (ON CONFLICT DO UPDATE on the composite pk) let run
 * start / completion / failure each write without a read-modify-write race.
 *
 * This table is run STATE, not a result store. The materialized report
 * results still live where they already lived — site_topography /
 * site_drainage derived rows (replayed from atom history) and the brief /
 * hazard / encumbrances loaders. Only the subsurface + hazard-quota flags
 * that the old `reportResultCache` held inline are carried here (in
 * `result`), because those had no other home. Large payloads are never
 * duplicated here.
 */
export const reportRun = pgTable(
  "report_run",
  {
    engagementId: text("engagement_id").notNull(),
    /**
     * Normalized report type — one of the REPORT_TYPES union in
     * planReviewBff.ts (`property-brief` is normalized to `brief` before it
     * ever reaches this table). Stored as text, not an enum, so adding a
     * report type never needs a migration.
     */
    reportType: text("report_type").notNull(),
    /**
     * `running` (run POST upserted, work in flight) → `ok` (settled
     * successfully) | `error` (failed, `error`+`reason` carry the true
     * cause). `not-run` is never persisted — the ABSENCE of a row (or an
     * expired-stale running row) IS the not-run signal, matching the old
     * "no map entry" semantics.
     */
    status: text("status").notNull(),
    /** The `gen-<ts>` id returned to the client on the run POST. */
    generationId: text("generation_id").notNull(),
    /**
     * Run start (ms→timestamp). The #249 watchdog stale check now reads
     * THIS column instead of the in-memory `startedAt`, so a stale
     * `running` row is expired cross-instance, not just on the origin
     * instance.
     */
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Stamped on the terminal (`ok` / `error`) transition; null while running. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * Failure classifier (old `lastReportRunFailure.error`) — e.g.
     * `watchdog-stale`, `watchdog-timeout`, an adapter code, or the typed
     * ingest failure `status`. Null on `ok`.
     */
    error: text("error"),
    /** Human-readable failure reason (old `lastReportRunFailure.reason`). Null on `ok`. */
    reason: text("reason"),
    /**
     * Hydrology honesty fields threaded in #248 — mirrored onto run state so
     * the status GET can surface them cross-instance without re-reading the
     * materialized drainage row. `degraded` true means the run produced a
     * result but a data layer was unavailable; `degradedReason` carries why;
     * `library` names the hydrology library used. Null when not applicable.
     */
    degraded: text("degraded"),
    degradedReason: text("degraded_reason"),
    library: text("library"),
    /**
     * Inline result pointer for report types with NO separate result store —
     * today only `subsurface` (SSURGO adapter output / unavailable reason)
     * and the `hazard` quota-exhausted flag, which the old
     * `reportResultCache` held in memory. Never used to duplicate a payload
     * that already lives in a derived-state table.
     */
    result: jsonb("result"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.engagementId, t.reportType] }),
  }),
);

export type ReportRunRow = typeof reportRun.$inferSelect;
export type ReportRunInsert = typeof reportRun.$inferInsert;
