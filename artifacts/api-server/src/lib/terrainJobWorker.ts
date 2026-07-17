/**
 * Async parcel-terrain job — enqueue + fire-and-forget worker
 * (async-terrain-job).
 *
 * The site-topography ingest (DEM -> gridded triangle mesh -> GLB ->
 * ifcopenshell IFC) used to run SYNCHRONOUSLY inside the refresh request
 * handler. The mesh triangulation is a nested per-pixel loop and the IFC author
 * spawns a Python sidecar; on the shared 2-CPU cortex-api container both pegged
 * the cores and starved the co-scheduled 29s brief request, producing Cloud Run
 * "malformed response" 503s.
 *
 * This module moves that authoring OFF the request path using the same
 * fire-and-forget shape `viewpoint_renders` uses:
 *
 *   enqueueTerrainJob()  inserts a `queued` terrain_generation_jobs row and
 *                        `void`-launches runTerrainJob(); the route returns 202
 *                        immediately (no awaiting the mesh/IFC authoring).
 *   runTerrainJob()      flips the row to `generating`, runs ingestSiteTopography
 *                        (which now builds the mesh on a worker thread — see
 *                        terrainMeshWorker), and drives the row to a terminal
 *                        state (ready | failed | no-coverage).
 *
 * Single-flight is enforced by the partial unique index on (engagement_id)
 * WHERE status in ('queued','generating'): a concurrent enqueue loses on the
 * unique-violation and we return the existing active job's id instead of
 * launching a second authoring run — exactly the CPU contention being removed.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  terrainGenerationJobs,
  type TerrainGenerationJob,
} from "@workspace/db";
import type { EventAnchoringService } from "@hauska/atom-contract";
import { getHistoryService } from "../atoms/registry";
import { ingestSiteTopography } from "./siteTopographyIngest";
import { logger as defaultLogger } from "./logger";

/** Terminal + non-terminal status values. Narrowed wire union. */
export type TerrainJobStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "no-coverage";

const ACTIVE_STATUSES: ReadonlyArray<TerrainJobStatus> = ["queued", "generating"];

/** PG unique-violation SQLSTATE — mirrors routes/parcelBriefings.ts. */
const PG_UNIQUE_VIOLATION = "23505";

/** Drizzle wraps pg errors; check both the top level and `.cause`. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || cause === PG_UNIQUE_VIOLATION;
}

/** Normalized ingest params carried on the job row and read back by the worker. */
export interface TerrainJobParams {
  contourIntervalMeters?: number;
  catchmentBufferMeters?: number;
  demResolutionMeters?: number;
  forceRefresh?: boolean;
  jurisdictionTenant?: string | null;
}

export interface EnqueueTerrainJobArgs {
  engagementId: string;
  placeKey?: string | null;
  params?: TerrainJobParams;
  log?: typeof defaultLogger;
  /**
   * Test / worker-context seam. Defaults to the module runner that `void`-fires
   * `runTerrainJob`. Tests pass a no-op so enqueue can be asserted without a
   * live ingest.
   */
  launch?: (jobId: string) => void;
}

export type EnqueueTerrainJobResult =
  | { kind: "queued"; jobId: string; alreadyInFlight: false }
  | { kind: "already_in_flight"; jobId: string; alreadyInFlight: true };

/**
 * Look up the current active (queued|generating) job for an engagement, if any.
 * Used both to return the existing job on a single-flight loss and by the read
 * route to report in-progress status.
 */
export async function loadActiveTerrainJob(
  engagementId: string,
): Promise<TerrainGenerationJob | null> {
  const rows = await db
    .select()
    .from(terrainGenerationJobs)
    .where(
      and(
        eq(terrainGenerationJobs.engagementId, engagementId),
        inArray(terrainGenerationJobs.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(terrainGenerationJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Load the most-recent terrain job for an engagement, any status. */
export async function loadLatestTerrainJob(
  engagementId: string,
): Promise<TerrainGenerationJob | null> {
  const rows = await db
    .select()
    .from(terrainGenerationJobs)
    .where(eq(terrainGenerationJobs.engagementId, engagementId))
    .orderBy(desc(terrainGenerationJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Load a terrain job by its id (the public jobId). */
export async function loadTerrainJobById(
  jobId: string,
): Promise<TerrainGenerationJob | null> {
  const rows = await db
    .select()
    .from(terrainGenerationJobs)
    .where(eq(terrainGenerationJobs.id, jobId))
    .limit(1);
  return rows[0] ?? null;
}

const defaultLaunch = (jobId: string): void => {
  // Fire-and-forget. The refresh route has already returned 202; the worker
  // runs the authoring off the request path and settles the row. Errors are
  // caught inside runTerrainJob and stamped on the row, so nothing escapes.
  void runTerrainJob(jobId);
};

/**
 * Enqueue a terrain generation job and launch its worker off the request path.
 *
 * Inserts a `queued` row and `void`-fires the worker. Returns immediately with
 * the jobId so the route can respond 202. On a single-flight loss (an active
 * job already exists for the engagement) returns that job's id with
 * `alreadyInFlight: true` and does NOT launch a second worker.
 */
export async function enqueueTerrainJob(
  args: EnqueueTerrainJobArgs,
): Promise<EnqueueTerrainJobResult> {
  const log = args.log ?? defaultLogger;
  const launch = args.launch ?? defaultLaunch;

  try {
    const inserted = await db
      .insert(terrainGenerationJobs)
      .values({
        engagementId: args.engagementId,
        placeKey: args.placeKey ?? null,
        requestPayload: (args.params ?? {}) as Record<string, unknown>,
        status: "queued",
      })
      .returning({ id: terrainGenerationJobs.id });
    const jobId = inserted[0]?.id;
    if (!jobId) {
      throw new Error("terrain_generation_jobs insert returned no id");
    }
    log.info(
      { engagementId: args.engagementId, jobId, placeKey: args.placeKey },
      "terrain job: enqueued",
    );
    launch(jobId);
    return { kind: "queued", jobId, alreadyInFlight: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A queued/generating job already exists for this engagement. Return it
      // so the caller re-polls the in-flight run rather than launching a
      // second authoring pass (the CPU contention we are removing).
      const existing = await loadActiveTerrainJob(args.engagementId);
      if (existing) {
        log.info(
          {
            engagementId: args.engagementId,
            jobId: existing.id,
            status: existing.status,
          },
          "terrain job: enqueue lost single-flight; returning active job",
        );
        return {
          kind: "already_in_flight",
          jobId: existing.id,
          alreadyInFlight: true,
        };
      }
    }
    throw err;
  }
}

/**
 * Run a queued terrain job: flip to `generating`, run the ingest off the
 * request path, and drive the row to a terminal state. Never throws — every
 * failure is caught and stamped on the row so the fire-and-forget launch cannot
 * produce an unhandled rejection.
 */
export async function runTerrainJob(
  jobId: string,
  deps?: { history?: EventAnchoringService; log?: typeof defaultLogger },
): Promise<void> {
  const log = deps?.log ?? defaultLogger;
  const history = deps?.history ?? getHistoryService();

  let job: TerrainGenerationJob | null;
  try {
    job = await loadTerrainJobById(jobId);
  } catch (err) {
    log.error({ err, jobId }, "terrain job: failed to load job row");
    return;
  }
  if (!job) {
    log.warn({ jobId }, "terrain job: row not found; nothing to run");
    return;
  }
  if (job.status !== "queued") {
    // Already claimed / settled (a rescue sweep or a duplicate launch). Skip.
    log.info(
      { jobId, status: job.status },
      "terrain job: not in 'queued'; skipping run",
    );
    return;
  }

  // Claim the row: queued -> generating. The WHERE status='queued' guard makes
  // this an atomic compare-and-set so a duplicate launch or a sweep-driven
  // re-run can't both proceed.
  const claimed = await db
    .update(terrainGenerationJobs)
    .set({ status: "generating", updatedAt: new Date() })
    .where(
      and(
        eq(terrainGenerationJobs.id, jobId),
        eq(terrainGenerationJobs.status, "queued"),
      ),
    )
    .returning({ id: terrainGenerationJobs.id });
  if (claimed.length === 0) {
    log.info({ jobId }, "terrain job: lost the claim race; another runner has it");
    return;
  }

  const params = (job.requestPayload ?? {}) as TerrainJobParams;

  try {
    const result = await ingestSiteTopography({
      engagementId: job.engagementId,
      history,
      jurisdictionTenant: params.jurisdictionTenant ?? null,
      contourIntervalMeters: params.contourIntervalMeters,
      catchmentBufferMeters: params.catchmentBufferMeters,
      demResolutionMeters: params.demResolutionMeters,
      forceRefresh: params.forceRefresh,
      log,
    });

    if (result.status === "ok") {
      await db
        .update(terrainGenerationJobs)
        .set({
          status: "ready",
          materializableElementId: result.materializableElementId,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(terrainGenerationJobs.id, jobId));
      log.info(
        {
          jobId,
          engagementId: job.engagementId,
          materializableElementId: result.materializableElementId,
          reusedExisting: result.reusedExisting,
        },
        "terrain job: ready",
      );
      return;
    }

    if (result.status === "no-parcel-coverage") {
      await db
        .update(terrainGenerationJobs)
        .set({
          status: "no-coverage",
          errorCode: "no-parcel-coverage",
          errorMessage: truncate(result.reason),
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(terrainGenerationJobs.id, jobId));
      log.info(
        { jobId, engagementId: job.engagementId },
        "terrain job: no-coverage",
      );
      return;
    }

    // upstream-error
    await db
      .update(terrainGenerationJobs)
      .set({
        status: "failed",
        errorCode: result.code,
        errorMessage: truncate(result.reason),
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(terrainGenerationJobs.id, jobId));
    log.warn(
      { jobId, engagementId: job.engagementId, code: result.code },
      "terrain job: failed (upstream-error)",
    );
  } catch (err) {
    // The ingest worker is supposed to catch its recoverable failures and
    // return a typed result; reaching here is unexpected. Stamp the row failed
    // so the poller sees an honest terminal state.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, jobId, engagementId: job.engagementId },
      "terrain job: unhandled worker error",
    );
    try {
      await db
        .update(terrainGenerationJobs)
        .set({
          status: "failed",
          errorCode: "internal_worker_error",
          errorMessage: truncate(message),
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(terrainGenerationJobs.id, jobId));
    } catch (updateErr) {
      log.error(
        { err: updateErr, jobId },
        "terrain job: failed to stamp failure status",
      );
    }
  }
}

/** Truncate a long failure message so the row stays bounded. */
function truncate(s: string, max = 2000): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
