/**
 * Operator run-state projection for the command center's Run Monitor panel.
 *
 * HONEST-EMPTY BY DESIGN. This is a read-only status projection over data that
 * ALREADY EXISTS — it does NOT run, schedule, or fabricate a warming harness.
 *
 * What "warming run-state" actually is in this system (survey, 2026-07-15):
 *   - The warming harness (`lib/warmingHarness.ts`, `runWarmingCascade`) is a
 *     W1 SCAFFOLD. Its only callers are the on-demand HTTP routes in
 *     `routes/brokeragePlace.ts` (`POST .../place/warming/run` and the
 *     snapshot-coverage probe). Nothing invokes it on a schedule — there is no
 *     cron, no boot-time interval, no queue worker that warms parcels. The
 *     three boot sweeps (`adapterCache`, `briefingGenerationJobs`,
 *     `findingRuns`) are cleanup sweeps, not warming. So the truthful harness
 *     state is `not-scheduled`.
 *   - The REAL run-state that DOES exist is the durable `report_run` table
 *     (#253): the plan-review report-run pipeline's cross-instance status
 *     (running / ok / error, keyed by engagement + report type). That is
 *     genuine run history and is what this projection surfaces as `recentRuns`.
 *   - The only real "warmed" artifacts are `place_layer_snapshots` rows —
 *     snapshot-backed adapter payloads keyed by place. Counting distinct places
 *     gives an honest `parcelsWarmed`; it is snapshot coverage, NOT a running
 *     warm loop, and the payload labels it as such.
 *
 * The panel (hauska-map `RunMonitor.tsx`) goes "live" when the projection
 * carries at least one of `parcelsWarmed`, `computeCostUsd`, `adapterFailures`,
 * or a non-empty `recentRuns`. When `report_run` and `place_layer_snapshots`
 * are both empty the projection is honestly empty and the panel renders its
 * "no run" state listing the endpoints attempted — the correct expression of
 * the spine's honest-empty-over-fake-full ethos.
 *
 * Compute cost/budget is intentionally NULL: this system records no per-run
 * compute cost, so asserting a number would be fabrication. The panel renders
 * "—" for a null cost, which is honest.
 */

import { desc, eq, sql } from "drizzle-orm";
import {
  db as prodDb,
  reportRun,
  placeLayerSnapshots,
} from "@workspace/db";

type Db = typeof prodDb;

/** One recent report-run row, in the shape RunMonitor's `RunRow` reads. */
export interface OperatorRecentRun {
  /** `${engagementId}:${reportType}` — the composite key the row is stored under. */
  id: string;
  runId: string;
  engagementId: string;
  reportType: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Honest harness metadata — states the truth that nothing runs on a schedule. */
export interface WarmingHarnessState {
  /**
   * `not-scheduled`: no recurring job invokes the warming cascade (survey
   * finding — the cascade is an on-demand scaffold only). This is the honest
   * current state, not a placeholder.
   */
  scheduled: false;
  status: "not-scheduled";
  /**
   * Never null-punned into a running signal. The warming cascade exists as an
   * on-demand route; it is not driven by any scheduler.
   */
  lastRunAt: null;
  note: string;
}

export interface OperatorRunState {
  /** `ok` when real run-state exists to show; `empty` when nothing does. */
  status: "ok" | "empty";
  source: "cortex-api/report_run+place_layer_snapshots";
  generatedAt: string;
  harness: WarmingHarnessState;
  /** Distinct places with at least one snapshot row (snapshot coverage, not a live warm). */
  parcelsWarmed: number;
  /** Same universe today (no separate "tracked but unwarmed" set is materialized). */
  parcelsTracked: number;
  parcelsWarmedPct: number | null;
  /** report_run rows in `error` status — real adapter/run failures. */
  adapterFailures: number;
  /** No per-run compute cost is recorded; null is honest, never a fabricated number. */
  computeCostUsd: null;
  computeBudgetUsd: null;
  /** Coverage holes / contested ground / triage are not materialized here. */
  coverageHoles: null;
  contestedGround: null;
  triageCounts: {
    running: number;
    ok: number;
    error: number;
  };
  recentRuns: OperatorRecentRun[];
  message: string;
}

const HARNESS_NOTE =
  "The warming cascade (W1) is an on-demand scaffold invoked only via POST " +
  "/api/brokerage/v1/place/warming/run; no scheduler drives it. Run-state below " +
  "is the durable plan-review report_run history plus place_layer_snapshots " +
  "coverage — the real run-state that exists today.";

function harnessState(): WarmingHarnessState {
  return {
    scheduled: false,
    status: "not-scheduled",
    lastRunAt: null,
    note: HARNESS_NOTE,
  };
}

/**
 * Build the honest run-state projection. Read-only: three cheap aggregate reads
 * against tables that already exist. Never writes, never triggers a harness.
 */
export async function buildOperatorRunState(
  db: Db = prodDb,
  recentLimit = 25,
): Promise<OperatorRunState> {
  const [recentRows, [warmedRow], statusRows] = await Promise.all([
    db
      .select()
      .from(reportRun)
      .orderBy(desc(reportRun.updatedAt))
      .limit(recentLimit),
    db
      .select({
        distinctPlaces: sql<number>`count(distinct ${placeLayerSnapshots.placeKey})`,
      })
      .from(placeLayerSnapshots),
    db
      .select({
        status: reportRun.status,
        n: sql<number>`count(*)`,
      })
      .from(reportRun)
      .groupBy(reportRun.status),
  ]);

  const parcelsWarmed = Number(warmedRow?.distinctPlaces ?? 0);

  const triageCounts = { running: 0, ok: 0, error: 0 };
  for (const row of statusRows) {
    const n = Number(row.n ?? 0);
    if (row.status === "running") triageCounts.running += n;
    else if (row.status === "ok") triageCounts.ok += n;
    else if (row.status === "error") triageCounts.error += n;
  }

  const recentRuns: OperatorRecentRun[] = recentRows.map((r) => ({
    id: `${r.engagementId}:${r.reportType}`,
    runId: r.generationId,
    engagementId: r.engagementId,
    reportType: r.reportType,
    status: r.status,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error ?? null,
  }));

  const hasRealState = recentRuns.length > 0 || parcelsWarmed > 0;

  return {
    status: hasRealState ? "ok" : "empty",
    source: "cortex-api/report_run+place_layer_snapshots",
    generatedAt: new Date().toISOString(),
    harness: harnessState(),
    parcelsWarmed,
    parcelsTracked: parcelsWarmed,
    parcelsWarmedPct: parcelsWarmed > 0 ? 100 : null,
    adapterFailures: triageCounts.error,
    computeCostUsd: null,
    computeBudgetUsd: null,
    coverageHoles: null,
    contestedGround: null,
    triageCounts,
    recentRuns,
    message: hasRealState
      ? "Warming harness not scheduled; showing durable report_run history + place_layer_snapshots coverage."
      : "Warming harness not scheduled and no report_run / place_layer_snapshots rows yet — honestly empty.",
  };
}
