/**
 * Rescue stale `finding_runs` rows stuck in `pending` after worker
 * crashes / deploy restarts, and run the sweep on api-server boot.
 *
 * Unlike `briefingGenerationJobsSweep`, this module's primary job is
 * stuck-pending rescue — there is no heartbeat column on finding runs,
 * so liveness is inferred from `started_at` + a wall-clock threshold.
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db as prodDb, findingRuns, submissions } from "@workspace/db";
import type { Logger } from "pino";

/** Wire + DB error token stamped on sweep-rescued orphan rows. */
export const FINDING_RUN_ORPHANED_TIMEOUT_ERROR = "orphaned-timeout";

/** Operator keystone engagement — one-time expire all pending on boot. */
export const MIAMI_KEYSTONE_ENGAGEMENT_ID =
  "15d1d314-c2fa-42d1-81f9-24eb06d94e3d";

/** Default: 30 min — orchestrated runs should finish well under this. */
export const DEFAULT_FINDING_RUN_RESCUE_THRESHOLD_MS = 30 * 60 * 1000;

/** Default sweep interval after boot. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Boot delay before first tick (0 = run immediately on startup). */
const DEFAULT_BOOT_DELAY_MS = 0;

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export interface RescueStalePendingFindingRunsOptions {
  db?: typeof prodDb;
  now?: Date;
  rescueThresholdMs?: number;
  /** Fail every pending run on these engagements regardless of age. */
  immediateEngagementIds?: string[];
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export interface RescueStalePendingFindingRunsResult {
  rescuedByTimeout: number;
  rescuedImmediate: number;
}

export async function rescueStalePendingFindingRuns(
  opts: RescueStalePendingFindingRunsOptions = {},
): Promise<RescueStalePendingFindingRunsResult> {
  const db = opts.db ?? prodDb;
  const now = opts.now ?? new Date();
  const thresholdMs =
    opts.rescueThresholdMs ?? DEFAULT_FINDING_RUN_RESCUE_THRESHOLD_MS;
  const cutoff = new Date(now.getTime() - thresholdMs);
  const log = opts.logger;

  let rescuedByTimeout = 0;
  let rescuedImmediate = 0;

  const immediateIds = opts.immediateEngagementIds ?? [];
  if (immediateIds.length > 0) {
    const immediateSubmissionRows = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(inArray(submissions.engagementId, immediateIds));
    const immediateSubmissionIds = immediateSubmissionRows.map((r) => r.id);
    if (immediateSubmissionIds.length > 0) {
      const immediateRows = await db
        .update(findingRuns)
        .set({
          state: "failed",
          error: FINDING_RUN_ORPHANED_TIMEOUT_ERROR,
          completedAt: now,
        })
        .where(
          and(
            eq(findingRuns.state, "pending"),
            inArray(findingRuns.submissionId, immediateSubmissionIds),
          ),
        )
        .returning({ id: findingRuns.id });
      rescuedImmediate = immediateRows.length;
      if (rescuedImmediate > 0) {
        log?.info(
          { count: rescuedImmediate, engagementIds: immediateIds },
          "finding runs sweep: expired pending runs (immediate engagement cleanup)",
        );
      }
    }
  }

  const timedOut = await db
    .update(findingRuns)
    .set({
      state: "failed",
      error: FINDING_RUN_ORPHANED_TIMEOUT_ERROR,
      completedAt: now,
    })
    .where(
      and(eq(findingRuns.state, "pending"), lt(findingRuns.startedAt, cutoff)),
    )
    .returning({ id: findingRuns.id });
  rescuedByTimeout = timedOut.length;
  if (rescuedByTimeout > 0) {
    log?.info(
      { count: rescuedByTimeout, cutoff: cutoff.toISOString() },
      "finding runs sweep: rescued stale pending runs",
    );
  }

  return { rescuedByTimeout, rescuedImmediate };
}

export async function runFindingRunsSweepTick(
  logger: Pick<Logger, "info" | "warn" | "error">,
): Promise<void> {
  if (inFlight) {
    logger.warn("finding runs sweep: tick skipped — previous tick still running");
    return;
  }
  inFlight = true;
  try {
    await rescueStalePendingFindingRuns({ logger });
  } catch (err) {
    logger.error({ err }, "finding runs sweep: tick failed");
  } finally {
    inFlight = false;
  }
}

export function startFindingRunsSweep(
  logger: Pick<Logger, "info" | "warn" | "error">,
): void {
  if (timer !== null || bootTimer !== null) {
    logger.warn("finding runs sweep: already started — ignoring duplicate start");
    return;
  }

  const intervalMs = Number(
    process.env["FINDING_RUNS_SWEEP_INTERVAL_MS"] ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  const bootDelayMs = Number(
    process.env["FINDING_RUNS_SWEEP_BOOT_DELAY_MS"] ?? DEFAULT_BOOT_DELAY_MS,
  );

  const kick = () => {
    void runFindingRunsSweepTick(logger);
  };

  bootTimer = setTimeout(() => {
    bootTimer = null;
    void (async () => {
      await rescueStalePendingFindingRuns({
        logger,
        immediateEngagementIds: [MIAMI_KEYSTONE_ENGAGEMENT_ID],
      });
      kick();
    })();
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      timer = setInterval(kick, intervalMs);
      timer.unref();
    }
  }, Math.max(0, bootDelayMs));
  bootTimer.unref();
}

export function stopFindingRunsSweep(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  inFlight = false;
}
