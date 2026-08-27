/**
 * P-85 WDLL item 4 — Records Request async jobs (terrainJobWorker pattern).
 *
 * Scaffold: enqueue, load, and list. Playwright portal worker (item 5) is
 * optional via RECORDS_REQUEST_WORKER_URL; launch defaults to no-op when unset.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  recordsRequestJobs,
  type RecordsRequestJob,
  type RecordsRequestJobStatus,
} from "@workspace/db";
import type { LiveEasementGisQueryAudit } from "./liveEasementGisQuery";
import { logger as defaultLogger } from "./logger";

export const RECORDS_REQUEST_RECIPE_VERSION = "p85-records-request-scaffold-v0";

const ACTIVE_STATUSES: ReadonlyArray<RecordsRequestJobStatus> = [
  "queued",
  "running",
  "awaiting-purchase-approval",
];

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || cause === PG_UNIQUE_VIOLATION;
}

export interface EnqueueRecordsRequestJobArgs {
  engagementId: string;
  userId: string;
  userEmail?: string | null;
  parcelKey: string;
  countyFips: string;
  placeKey?: string | null;
  liveInstantGis: LiveEasementGisQueryAudit;
  requestPayload?: Record<string, unknown>;
  log?: typeof defaultLogger;
  /** Test seam. Defaults to POST RECORDS_REQUEST_WORKER_URL or no-op when unset. */
  launch?: (jobId: string) => void;
}

export type EnqueueRecordsRequestJobResult =
  | { kind: "queued"; jobId: string; alreadyInFlight: false }
  | { kind: "already_in_flight"; jobId: string; alreadyInFlight: true };

function createDefaultLaunch(): (jobId: string) => void {
  const workerUrl = process.env.RECORDS_REQUEST_WORKER_URL?.trim();
  if (!workerUrl) {
    return (_jobId: string): void => {
      // No worker deployed — enqueue remains testable without a browser run.
    };
  }
  return (jobId: string): void => {
    void fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    }).catch((err) => {
      defaultLogger.error(
        { err, jobId, workerUrl },
        "records request job: worker URL invoke failed",
      );
    });
  };
}

const defaultLaunch = createDefaultLaunch();

/** Test seam — rebuild launch handler after env changes. */
export function buildRecordsRequestWorkerLaunch(): (jobId: string) => void {
  return createDefaultLaunch();
}

export async function loadActiveRecordsRequestJob(
  engagementId: string,
  userId: string,
): Promise<RecordsRequestJob | null> {
  const rows = await db
    .select()
    .from(recordsRequestJobs)
    .where(
      and(
        eq(recordsRequestJobs.engagementId, engagementId),
        eq(recordsRequestJobs.userId, userId),
        inArray(recordsRequestJobs.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(recordsRequestJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadRecordsRequestJobById(
  jobId: string,
): Promise<RecordsRequestJob | null> {
  const rows = await db
    .select()
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, jobId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRecordsRequestJobsForEngagement(
  engagementId: string,
  userId: string,
): Promise<RecordsRequestJob[]> {
  return db
    .select()
    .from(recordsRequestJobs)
    .where(
      and(
        eq(recordsRequestJobs.engagementId, engagementId),
        eq(recordsRequestJobs.userId, userId),
      ),
    )
    .orderBy(desc(recordsRequestJobs.createdAt));
}

export function recordsRequestJobToWire(job: RecordsRequestJob): Record<string, unknown> {
  return {
    jobId: job.id,
    engagementId: job.engagementId,
    placeKey: job.placeKey,
    userId: job.userId,
    parcelKey: job.parcelKey,
    countyFips: job.countyFips,
    status: job.status,
    jobStatus: job.status,
    requestPayload: job.requestPayload,
    scopeSearched: job.scopeSearched,
    liveInstantGis: job.liveInstantGis,
    runCost: job.runCost,
    recipeVersion: job.recipeVersion,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

/**
 * Enqueue a Records Request job. Inserts the row (with live GIS audit) before
 * any worker launch. On single-flight loss returns the existing active job.
 */
export async function enqueueRecordsRequestJob(
  args: EnqueueRecordsRequestJobArgs,
): Promise<EnqueueRecordsRequestJobResult> {
  const log = args.log ?? defaultLogger;
  const launch = args.launch ?? defaultLaunch;

  try {
    const inserted = await db
      .insert(recordsRequestJobs)
      .values({
        engagementId: args.engagementId,
        placeKey: args.placeKey ?? null,
        userId: args.userId,
        userEmail: args.userEmail ?? null,
        parcelKey: args.parcelKey,
        countyFips: args.countyFips,
        status: "queued",
        requestPayload: args.requestPayload ?? {},
        liveInstantGis: args.liveInstantGis,
        recipeVersion: RECORDS_REQUEST_RECIPE_VERSION,
      })
      .returning({ id: recordsRequestJobs.id });
    const jobId = inserted[0]?.id;
    if (!jobId) {
      throw new Error("records_request_jobs insert returned no id");
    }
    log.info(
      {
        engagementId: args.engagementId,
        jobId,
        parcelKey: args.parcelKey,
        countyFips: args.countyFips,
      },
      "records request job: enqueued",
    );
    launch(jobId);
    return { kind: "queued", jobId, alreadyInFlight: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await loadActiveRecordsRequestJob(
        args.engagementId,
        args.userId,
      );
      if (existing) {
        log.info(
          {
            engagementId: args.engagementId,
            jobId: existing.id,
            status: existing.status,
          },
          "records request job: enqueue lost single-flight; returning active job",
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
