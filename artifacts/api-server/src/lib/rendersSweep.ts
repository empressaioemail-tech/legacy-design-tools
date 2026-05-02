/**
 * V1-4 / DA-RP-1 — renders sweep helper.
 *
 * Cron-invoked maintenance pass over `viewpoint_renders` and
 * `render_outputs`. Distinct from `briefingGenerationJobsSweep`: that
 * one is timer-based + cluster-locked + auto-fires on boot. This one
 * is a pure function exposed via `POST /api/admin/renders/sweep`,
 * intended to be called by Cloud Scheduler. Single invocation, no
 * background timer.
 *
 * Three responsibilities:
 *
 * 1. Stuck-render rescue. Rows in `queued` or `rendering` whose
 *    `created_at` is older than the polling worker's wall-clock cap
 *    + slack. The route's worker is supposed to time these out
 *    internally (10-minute cap → status='failed' /
 *    error_code='polling_timeout'), but worker crashes — server
 *    restart, unhandled async, OOM — leave the row pinned. The
 *    sweep mops them up by transitioning to status='failed' /
 *    error_code='polling_timeout_sweep' (suffix distinguishes the
 *    sweep-rescued rows from worker-self-failed rows in postmortems).
 *
 * 2. Old terminal reap. Rows in `failed` or `cancelled` with
 *    `completed_at` older than the retention window are DELETEd
 *    (cascading delete also wipes their render_outputs). `ready`
 *    rows are NEVER reaped — their outputs are user-facing artifacts
 *    the architect may revisit indefinitely. Mirrors the
 *    briefing-engine sweep's "ready vs failed" asymmetry.
 *
 * 3. Incomplete-mirror detection. Rows in `ready` whose render_outputs
 *    children carry NULL `mirrored_object_key` SHOULD NOT EXIST given
 *    the route's transactional persistence path — but the sweep
 *    surfaces them via a structured warning log so a future operator
 *    review catches state drift early. V1-4 does not auto-heal these
 *    (no clear policy on "re-mirror from mnml URL that may have
 *    expired"); a future sprint can add policy + healing.
 *
 * Returns a {@link RendersSweepResult} summarizing counts so the
 * cron route can log + the operator can verify the sweep did
 * something. Errors inside the sweep are caught + logged; the
 * function does not throw to the caller (the cron schedule keeps
 * running on the next tick).
 */

import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  db as prodDb,
  renderOutputs,
  viewpointRenders,
} from "@workspace/db";
import type { Logger } from "pino";

/** Default rescue threshold: 15 min. Worker's own cap is 10 min. */
const DEFAULT_RESCUE_THRESHOLD_MS = 15 * 60 * 1000;
/** Default retention window for failed/cancelled: 30 days. */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RendersSweepResult {
  /**
   * Count of rows we transitioned from `queued`/`rendering` to
   * `failed` because their poll-loop wall-clock had blown past the
   * rescue threshold.
   */
  rescuedStuck: number;
  /** Count of `failed`/`cancelled` rows we DELETEd. */
  reapedTerminal: number;
  /**
   * Count of `ready` rows whose render_outputs carry NULL
   * `mirrored_object_key`. Logged as warnings; no state change.
   */
  warnedIncompleteMirror: number;
  /** Wall-clock elapsed in the sweep call. Surfaced for SLO tracking. */
  durationMs: number;
}

export interface RunRendersSweepOptions {
  /**
   * Override the prod db with a per-test-schema drizzle client.
   * Tests pass `schema.db` so updates / deletes land in the
   * isolated test schema rather than dev. Defaults to the prod
   * `db` import.
   */
  db?: typeof prodDb;
  /** Override the clock — tests pass a fixed Date. Defaults to `new Date()`. */
  now?: Date;
  /** Stuck-rescue cutoff. Defaults to {@link DEFAULT_RESCUE_THRESHOLD_MS}. */
  rescueThresholdMs?: number;
  /** Reap retention window. Defaults to {@link DEFAULT_RETENTION_MS}. */
  retentionMs?: number;
  /** Optional structured logger. Defaults to no-op. */
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Run one sweep pass. Idempotent — multiple invocations on the same
 * minute produce the same end state (no double-deletes; no double-
 * transitions because each predicate filter rules out already-handled
 * rows).
 */
export async function runRendersSweep(
  opts: RunRendersSweepOptions = {},
): Promise<RendersSweepResult> {
  const db = opts.db ?? prodDb;
  const now = opts.now ?? new Date();
  const rescueThresholdMs = opts.rescueThresholdMs ?? DEFAULT_RESCUE_THRESHOLD_MS;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const logger = opts.logger ?? noopLogger;
  const startedAt = Date.now();

  const result: RendersSweepResult = {
    rescuedStuck: 0,
    reapedTerminal: 0,
    warnedIncompleteMirror: 0,
    durationMs: 0,
  };

  try {
    result.rescuedStuck = await rescueStuckRenders({
      db,
      now,
      rescueThresholdMs,
      logger,
    });
  } catch (err) {
    logger.error({ err }, "renders sweep: rescueStuckRenders failed");
  }

  try {
    result.reapedTerminal = await reapOldTerminalRenders({
      db,
      now,
      retentionMs,
      logger,
    });
  } catch (err) {
    logger.error({ err }, "renders sweep: reapOldTerminalRenders failed");
  }

  try {
    result.warnedIncompleteMirror = await warnIncompleteMirror({ db, logger });
  } catch (err) {
    logger.error({ err }, "renders sweep: warnIncompleteMirror failed");
  }

  result.durationMs = Date.now() - startedAt;
  logger.info({ ...result }, "renders sweep complete");
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Bucket 1: stuck rescue
// ─────────────────────────────────────────────────────────────────────

async function rescueStuckRenders(args: {
  db: typeof prodDb;
  now: Date;
  rescueThresholdMs: number;
  logger: Pick<Logger, "info" | "warn" | "error">;
}): Promise<number> {
  const cutoff = new Date(args.now.getTime() - args.rescueThresholdMs);
  // UPDATE … RETURNING gives us the count + the rescued ids in one
  // round trip. The `created_at < cutoff` predicate excludes anything
  // a fresh kickoff might be racing with — a render that started 30s
  // ago is well within the worker's normal poll window and should
  // not be touched even if the schedule fired right after it
  // started.
  const rescued = await args.db
    .update(viewpointRenders)
    .set({
      status: "failed",
      errorCode: "polling_timeout_sweep",
      errorMessage:
        "renders sweep: render exceeded rescue threshold while polling worker did not transition it",
      completedAt: args.now,
      updatedAt: args.now,
    })
    .where(
      and(
        inArray(viewpointRenders.status, ["queued", "rendering"]),
        lt(viewpointRenders.createdAt, cutoff),
      ),
    )
    .returning({ id: viewpointRenders.id });

  if (rescued.length > 0) {
    args.logger.warn(
      {
        count: rescued.length,
        ids: rescued.map((r) => r.id),
        cutoffIso: cutoff.toISOString(),
      },
      "renders sweep: rescued stuck renders",
    );
  }
  return rescued.length;
}

// ─────────────────────────────────────────────────────────────────────
// Bucket 2: old terminal reap
// ─────────────────────────────────────────────────────────────────────

async function reapOldTerminalRenders(args: {
  db: typeof prodDb;
  now: Date;
  retentionMs: number;
  logger: Pick<Logger, "info" | "warn" | "error">;
}): Promise<number> {
  const cutoff = new Date(args.now.getTime() - args.retentionMs);
  // `ready` rows are user-facing artifacts and never reaped.
  // Cancelled rows reap on the same cutoff as failed — both are
  // terminal-but-not-served.
  const reaped = await args.db
    .delete(viewpointRenders)
    .where(
      and(
        inArray(viewpointRenders.status, ["failed", "cancelled"]),
        lt(viewpointRenders.completedAt, cutoff),
      ),
    )
    .returning({ id: viewpointRenders.id });

  if (reaped.length > 0) {
    args.logger.info(
      {
        count: reaped.length,
        cutoffIso: cutoff.toISOString(),
      },
      "renders sweep: reaped old terminal renders",
    );
  }
  return reaped.length;
}

// ─────────────────────────────────────────────────────────────────────
// Bucket 3: incomplete-mirror warning
// ─────────────────────────────────────────────────────────────────────

async function warnIncompleteMirror(args: {
  db: typeof prodDb;
  logger: Pick<Logger, "info" | "warn" | "error">;
}): Promise<number> {
  // Rows in `ready` whose ANY child render_output has NULL
  // mirrored_object_key. The route's transactional persistence path
  // does not produce this state — the warning fires only when
  // something has poked the DB out-of-band (manual ops, migration
  // bug, future schema drift). DISTINCT because a single render
  // could have multiple incomplete outputs and we count parent rows.
  const incomplete = await args.db
    .selectDistinct({ id: viewpointRenders.id })
    .from(viewpointRenders)
    .innerJoin(
      renderOutputs,
      eq(renderOutputs.viewpointRenderId, viewpointRenders.id),
    )
    .where(
      and(
        eq(viewpointRenders.status, "ready"),
        isNull(renderOutputs.mirroredObjectKey),
      ),
    );

  if (incomplete.length > 0) {
    args.logger.warn(
      {
        count: incomplete.length,
        ids: incomplete.map((r) => r.id),
      },
      "renders sweep: render-outputs with NULL mirrored_object_key on ready parents — investigate",
    );
  }
  return incomplete.length;
}

// ─────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────

const noopLogger: Pick<Logger, "info" | "warn" | "error"> = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Pick<Logger, "info" | "warn" | "error">;
