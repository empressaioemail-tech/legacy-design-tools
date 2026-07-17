/**
 * Rescue orphaned `terrain_generation_jobs` rows and reap old terminal rows
 * (async-terrain-job), and run the sweep on api-server boot.
 *
 * The terrain authoring worker (terrainJobWorker.runTerrainJob) drives a job's
 * status in-process. If the api-server crashes / is redeployed mid-authoring, a
 * `queued` or `generating` row is left with no live worker to settle it — a
 * poller would wait forever. This sweep fails those orphans once they age past a
 * wall-clock threshold (the same liveness-by-timestamp shape findingRunsSweep
 * uses), and reaps old terminal (`failed` / `no-coverage`) rows so the table
 * stays bounded. `ready` rows are NEVER reaped — they carry the back-pointer to
 * a real materialized model and a later poll should still resolve them.
 *
 * Multi-instance safety: every api-server instance runs this on the same
 * cadence, so the rescue UPDATE runs inside `withClusterSweepLock` — one winner
 * per tick across the cluster, auto-released on commit/rollback.
 */

import { and, inArray, lt } from "drizzle-orm";
import {
  db as prodDb,
  terrainGenerationJobs,
  withClusterSweepLock,
} from "@workspace/db";
import type { Logger } from "pino";

/** Failure code stamped on sweep-rescued orphan rows. */
export const TERRAIN_JOB_ORPHANED_TIMEOUT_CODE = "orphaned-timeout";

/**
 * Default rescue threshold: 15 min. The terrain authoring (DEM fetch + mesh on
 * a worker thread + IFC spawn) finishes in seconds to low-minutes at
 * parcel/catchment scale; a row still queued/generating after 15 min means the
 * worker that owned it died. Distinct from any per-run self-timeout so the sweep
 * only catches genuinely orphaned rows.
 */
export const DEFAULT_TERRAIN_JOB_RESCUE_THRESHOLD_MS = 15 * 60 * 1000;

/** Default terminal-row retention: 30 days. */
export const DEFAULT_TERRAIN_JOB_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default sweep interval after boot. */
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Boot delay before first tick. */
const DEFAULT_BOOT_DELAY_MS = 60 * 1000;

/** Advisory-lock namespace for cluster-wide single-run coordination. */
const SWEEP_LOCK_NAMESPACE = "terrain_generation_jobs_sweep";

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export interface SweepTerrainJobsOptions {
  db?: typeof prodDb;
  now?: Date;
  rescueThresholdMs?: number;
  terminalRetentionMs?: number;
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

export interface SweepTerrainJobsResult {
  rescued: number;
  reaped: number;
}

export async function sweepTerrainGenerationJobs(
  opts: SweepTerrainJobsOptions = {},
): Promise<SweepTerrainJobsResult> {
  const db = opts.db ?? prodDb;
  const now = opts.now ?? new Date();
  const rescueCutoff = new Date(
    now.getTime() -
      (opts.rescueThresholdMs ?? DEFAULT_TERRAIN_JOB_RESCUE_THRESHOLD_MS),
  );
  const reapCutoff = new Date(
    now.getTime() -
      (opts.terminalRetentionMs ?? DEFAULT_TERRAIN_JOB_TERMINAL_RETENTION_MS),
  );
  const log = opts.logger;

  let rescued = 0;
  let reaped = 0;

  // 1) Rescue: fail queued/generating rows older than the threshold. Guarded by
  //    the cluster lock so only one instance does it per tick. The
  //    `created_at < cutoff` predicate structurally can't touch a fresh enqueue.
  const rescueOutcome = await withClusterSweepLock(
    db,
    SWEEP_LOCK_NAMESPACE,
    async (tx) => {
      return await tx
        .update(terrainGenerationJobs)
        .set({
          status: "failed",
          errorCode: TERRAIN_JOB_ORPHANED_TIMEOUT_CODE,
          errorMessage:
            "Terrain authoring was orphaned (worker crash or deploy restart) and swept.",
          updatedAt: now,
          completedAt: now,
        })
        .where(
          and(
            inArray(terrainGenerationJobs.status, ["queued", "generating"]),
            lt(terrainGenerationJobs.createdAt, rescueCutoff),
          ),
        )
        .returning({ id: terrainGenerationJobs.id });
    },
  );
  if (rescueOutcome.acquired) {
    rescued = rescueOutcome.result.length;
    if (rescued > 0) {
      log?.info(
        { count: rescued, cutoff: rescueCutoff.toISOString() },
        "terrain jobs sweep: rescued orphaned queued/generating rows",
      );
    }
  } else {
    log?.debug?.(
      {},
      "terrain jobs sweep: peer holds advisory lock, skipping rescue",
    );
  }

  // 2) Reap: delete old terminal failed/no-coverage rows. `ready` rows are
  //    never reaped (they point at a real model). Also cluster-locked.
  const reapOutcome = await withClusterSweepLock(
    db,
    `${SWEEP_LOCK_NAMESPACE}_reap`,
    async (tx) => {
      return await tx
        .delete(terrainGenerationJobs)
        .where(
          and(
            inArray(terrainGenerationJobs.status, ["failed", "no-coverage"]),
            lt(terrainGenerationJobs.completedAt, reapCutoff),
          ),
        )
        .returning({ id: terrainGenerationJobs.id });
    },
  );
  if (reapOutcome.acquired) {
    reaped = reapOutcome.result.length;
    if (reaped > 0) {
      log?.info(
        { count: reaped, cutoff: reapCutoff.toISOString() },
        "terrain jobs sweep: reaped old terminal rows",
      );
    }
  }

  return { rescued, reaped };
}

export async function runTerrainJobsSweepTick(
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">,
): Promise<void> {
  if (inFlight) {
    logger.warn(
      "terrain jobs sweep: tick skipped — previous tick still running",
    );
    return;
  }
  inFlight = true;
  try {
    await sweepTerrainGenerationJobs({ logger });
  } catch (err) {
    logger.error({ err }, "terrain jobs sweep: tick failed");
  } finally {
    inFlight = false;
  }
}

export function startTerrainJobsSweep(
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">,
): void {
  if (timer !== null || bootTimer !== null) {
    logger.warn(
      "terrain jobs sweep: already started — ignoring duplicate start",
    );
    return;
  }

  const intervalMs = Number(
    process.env["TERRAIN_JOBS_SWEEP_INTERVAL_MS"] ?? DEFAULT_SWEEP_INTERVAL_MS,
  );
  const bootDelayMs = Number(
    process.env["TERRAIN_JOBS_SWEEP_BOOT_DELAY_MS"] ?? DEFAULT_BOOT_DELAY_MS,
  );

  const kick = () => {
    void runTerrainJobsSweepTick(logger);
  };

  bootTimer = setTimeout(() => {
    bootTimer = null;
    kick();
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      timer = setInterval(kick, intervalMs);
      timer.unref();
    }
  }, Math.max(0, bootDelayMs));
  bootTimer.unref();
}

export function stopTerrainJobsSweep(): void {
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
