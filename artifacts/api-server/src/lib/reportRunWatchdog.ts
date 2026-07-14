/**
 * Report-run watchdog — guarantees every plan-review report run reaches a
 * terminal state.
 *
 * Live incident (2026-07-14, post #248 deploy): a drainage run whose
 * client disconnected at its own 180s timeout left the in-flight entry
 * behind and the status GET answered `{status:"running"}` indefinitely —
 * the synchronous handler stalled on a downstream await that never
 * settled within any bounded budget. Two guards close that class:
 *
 * 1. `runWithWatchdog` races the ingest against a hard budget inside the
 *    run handler itself, so the handler always reaches a terminal branch
 *    (records failure, clears in-flight, responds 504) even when a
 *    downstream await hangs. The orphaned work keeps running and its
 *    late outcome is logged, never surfaced as state.
 * 2. The status GET treats any in-flight entry older than the budget
 *    (plus grace) as failed-stale — covering the case where the handler
 *    itself was starved (e.g. CPU throttled after client disconnect) and
 *    the in-process timer never fired.
 */

export interface InFlightReportRun {
  generationId: string;
  startedAt: number;
}

/** Hard budget for one synchronous report run (ms). Env-overridable. */
export function reportRunWatchdogBudgetMs(): number {
  const raw = Number(process.env.REPORT_RUN_WATCHDOG_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60_000;
}

/**
 * Grace on top of the budget before the status GET declares a run
 * failed-stale (covers the in-process timer firing late under throttle).
 */
export const WATCHDOG_STALE_GRACE_MS = 30_000;

/** True when an in-flight entry has outlived the budget + grace. */
export function isInFlightRunStale(
  entry: InFlightReportRun,
  nowMs: number,
  budgetMs: number = reportRunWatchdogBudgetMs(),
): boolean {
  return nowMs - entry.startedAt > budgetMs + WATCHDOG_STALE_GRACE_MS;
}

export type WatchdogOutcome<T> =
  | { timedOut: false; result: T }
  | { timedOut: true };

/**
 * Race `work` against the watchdog budget. On timeout the caller gets
 * `{timedOut: true}` and MUST record a terminal failure; the orphaned
 * promise keeps running — `onLateSettle` receives its eventual outcome
 * for logging (never for state).
 */
export async function runWithWatchdog<T>(
  work: Promise<T>,
  budgetMs: number,
  onLateSettle?: (outcome: { ok: boolean; detail: string }) => void,
): Promise<WatchdogOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  // Keep the orphan observable and swallow its rejection so an abandoned
  // run can never crash the process via unhandledRejection.
  work.then(
    (result) => {
      if (settled) {
        onLateSettle?.({
          ok: true,
          detail: `late completion after watchdog timeout: ${JSON.stringify(result).slice(0, 200)}`,
        });
      }
    },
    (err) => {
      if (settled) {
        onLateSettle?.({
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
  try {
    const raced = await Promise.race([
      work.then((result) => ({ timedOut: false as const, result })),
      timeout,
    ]);
    settled = raced.timedOut;
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
