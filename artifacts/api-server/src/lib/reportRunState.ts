/**
 * Durable report-run STATE data access — cross-instance-correct status for
 * the plan-review report-run pipeline.
 *
 * Replaces the three instance-local Maps in
 * `artifacts/api-server/src/routes/planReviewBff.ts`:
 *   - `inFlightReports`      → a `report_run` row with `status = 'running'`
 *   - `lastReportRunFailure` → a `report_run` row with `status = 'error'`
 *   - `reportResultCache`    → a `report_run` row with `status = 'ok'` + `result`
 *
 * Keyed (engagement_id, report_type). On multi-instance Cloud Run a status
 * GET landing on a different instance than the one that ran the job used to
 * see `not-run` because the in-flight/failure/result Maps were per-process.
 * A shared row fixes that. Mirrors `findingRunsEngagement.ts`'s injectable
 * `db` handle so a cross-instance read is testable (write via one handle,
 * read via another — the same PG, distinct clients).
 *
 * Terminal-success semantics preserve the old fall-through exactly. Report
 * types that materialize their result elsewhere (topography / drainage /
 * hydrology derived rows, brief / hazard / encumbrances loaders) CLEAR the
 * row on success — deleting the running + failure signal so the status GET
 * falls through to the real result store, matching the old
 * "delete in-flight + clear failure". Only report types with NO other result
 * home (subsurface, and the hazard quota-exhausted flag) persist an `ok` row
 * carrying `result` — the old `reportResultCache`'s only real job.
 */

import { and, eq } from "drizzle-orm";
import { db as prodDb, reportRun, type ReportRunRow } from "@workspace/db";
import {
  isInFlightRunStale,
  reportRunWatchdogBudgetMs,
  type InFlightReportRun,
} from "./reportRunWatchdog";

type Db = typeof prodDb;

/** Non-null hydrology honesty fields threaded from the #248 drainage run. */
export interface ReportRunDegradedFields {
  degraded?: boolean | null;
  degradedReason?: string | null;
  library?: string | null;
}

/**
 * Upsert the `running` marker at run start. Idempotent on the composite pk —
 * a retry after a cleared-stale run overwrites the old row wholesale
 * (`started_at` reset, terminal columns nulled) so a fresh run never inherits
 * a prior failure's `error`/`reason`.
 */
export async function markReportRunRunning(
  engagementId: string,
  reportType: string,
  generationId: string,
  startedAtMs: number,
  db: Db = prodDb,
): Promise<void> {
  const startedAt = new Date(startedAtMs);
  await db
    .insert(reportRun)
    .values({
      engagementId,
      reportType,
      status: "running",
      generationId,
      startedAt,
      finishedAt: null,
      error: null,
      reason: null,
      degraded: null,
      degradedReason: null,
      library: null,
      result: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [reportRun.engagementId, reportRun.reportType],
      set: {
        status: "running",
        generationId,
        startedAt,
        finishedAt: null,
        error: null,
        reason: null,
        degraded: null,
        degradedReason: null,
        library: null,
        result: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Terminal success for a report type whose result is materialized elsewhere.
 * CLEARS the row (delete) so the status GET falls through to the real result
 * store — the durable equivalent of the old "inFlightReports.delete +
 * lastReportRunFailure.delete". Degraded fields, when present, are surfaced by
 * that result store already (drainage propertySet), so nothing is lost.
 */
export async function clearReportRun(
  engagementId: string,
  reportType: string,
  db: Db = prodDb,
): Promise<void> {
  await db
    .delete(reportRun)
    .where(
      and(
        eq(reportRun.engagementId, engagementId),
        eq(reportRun.reportType, reportType),
      ),
    );
}

/**
 * Terminal success for a report type with NO other result home (subsurface,
 * hazard quota-exhausted flag). Persists `ok` + inline `result` — the durable
 * `reportResultCache`. Degraded fields are optional (drainage-only) and
 * carried so a cross-instance status GET can surface them without re-reading
 * the derived row.
 */
export async function markReportRunOk(
  engagementId: string,
  reportType: string,
  generationId: string,
  result: unknown,
  degraded: ReportRunDegradedFields = {},
  db: Db = prodDb,
): Promise<void> {
  const now = new Date();
  const set = {
    status: "ok",
    generationId,
    finishedAt: now,
    error: null,
    reason: null,
    degraded:
      degraded.degraded == null ? null : degraded.degraded ? "true" : "false",
    degradedReason: degraded.degradedReason ?? null,
    library: degraded.library ?? null,
    result: result ?? null,
    updatedAt: now,
  } as const;
  await db
    .insert(reportRun)
    .values({
      engagementId,
      reportType,
      startedAt: now,
      ...set,
    })
    .onConflictDoUpdate({
      target: [reportRun.engagementId, reportRun.reportType],
      set,
    });
}

/**
 * Terminal failure — upsert `error` + classifier/reason. The durable
 * `lastReportRunFailure.set`. `finished_at` is stamped; `started_at` is left
 * as the upsert default (or the prior running row's value) because a fresh
 * status GET reads `status`/`error`, not the start time, on the failed path.
 */
export async function markReportRunError(
  engagementId: string,
  reportType: string,
  error: string,
  reason: string,
  generationId: string,
  db: Db = prodDb,
): Promise<void> {
  const now = new Date();
  const set = {
    status: "error",
    generationId,
    finishedAt: now,
    error,
    reason,
    updatedAt: now,
  } as const;
  await db
    .insert(reportRun)
    .values({
      engagementId,
      reportType,
      startedAt: now,
      ...set,
    })
    .onConflictDoUpdate({
      target: [reportRun.engagementId, reportRun.reportType],
      set,
    });
}

/** Load the single run-state row for (engagement, type), or null. */
export async function loadReportRun(
  engagementId: string,
  reportType: string,
  db: Db = prodDb,
): Promise<ReportRunRow | null> {
  const [row] = await db
    .select()
    .from(reportRun)
    .where(
      and(
        eq(reportRun.engagementId, engagementId),
        eq(reportRun.reportType, reportType),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Adapt a durable row to the watchdog's in-flight shape for the stale check. */
export function toInFlight(row: ReportRunRow): InFlightReportRun {
  return {
    generationId: row.generationId,
    startedAt: row.startedAt.getTime(),
  };
}

/** True when a `running` row has outlived the watchdog budget + grace. */
export function isReportRunStale(
  row: ReportRunRow,
  nowMs: number,
  budgetMs: number = reportRunWatchdogBudgetMs(),
): boolean {
  return isInFlightRunStale(toInFlight(row), nowMs, budgetMs);
}
