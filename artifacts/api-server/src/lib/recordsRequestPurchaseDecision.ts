/**
 * P-85 W1 item 6 — approve / decline county fee pause on Records Request jobs.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  recordsRequestJobs,
  type RecordsRequestJob,
  type RecordsRequestJobStatus,
} from "@workspace/db";
import {
  buildRecordsRequestWorkerLaunch,
  loadRecordsRequestJobById,
  recordsRequestJobToWire,
} from "./recordsRequestJobWorker";

const FEE_PAUSE_STATUSES: ReadonlyArray<RecordsRequestJobStatus> = [
  "awaiting-purchase-approval",
  "needs-human",
];

function scopeRecord(
  job: RecordsRequestJob,
): Record<string, unknown> | null {
  const scope = job.scopeSearched;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return null;
  }
  return scope as Record<string, unknown>;
}

export function jobEligibleForPurchaseDecision(job: RecordsRequestJob): boolean {
  if (!FEE_PAUSE_STATUSES.includes(job.status)) {
    return false;
  }
  if (job.errorCode === "awaiting-purchase-approval") {
    return true;
  }
  const scope = scopeRecord(job);
  if (!scope) return false;
  if (scope.awaitingPurchaseApproval === true) {
    return true;
  }
  const acquisition = scope.acquisition;
  if (acquisition && typeof acquisition === "object") {
    const pending = (acquisition as Record<string, unknown>).pendingPurchaseCount;
    if (typeof pending === "number" && pending > 0) {
      return true;
    }
  }
  const msg = job.errorMessage?.toLowerCase() ?? "";
  return msg.includes("purchase") || msg.includes("checkout");
}

export type PurchaseDecisionResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function approveRecordsRequestPurchase(args: {
  jobId: string;
  userId: string;
  launch?: (jobId: string) => void;
}): Promise<PurchaseDecisionResult> {
  const job = await loadRecordsRequestJobById(args.jobId);
  if (!job || job.userId !== args.userId) {
    return { ok: false, status: 404, body: { error: "job_not_found" } };
  }
  if (!jobEligibleForPurchaseDecision(job)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "job_not_awaiting_purchase_decision",
        jobStatus: job.status,
      },
    };
  }

  const payload =
    job.requestPayload && typeof job.requestPayload === "object"
      ? { ...(job.requestPayload as Record<string, unknown>) }
      : {};
  payload.purchaseApproved = true;
  payload.purchaseApprovedAt = new Date().toISOString();

  await db
    .update(recordsRequestJobs)
    .set({
      status: "queued",
      requestPayload: payload,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recordsRequestJobs.id, args.jobId),
        eq(recordsRequestJobs.userId, args.userId),
      ),
    );

  const launch = args.launch ?? buildRecordsRequestWorkerLaunch();
  launch(args.jobId);

  const updated = await loadRecordsRequestJobById(args.jobId);
  if (!updated) {
    return { ok: false, status: 500, body: { error: "job_reload_failed" } };
  }

  return {
    ok: true,
    status: 202,
    body: {
      ...recordsRequestJobToWire(updated),
      status: "accepted",
      purchaseApproved: true,
    },
  };
}

export async function declineRecordsRequestPurchase(args: {
  jobId: string;
  userId: string;
}): Promise<PurchaseDecisionResult> {
  const job = await loadRecordsRequestJobById(args.jobId);
  if (!job || job.userId !== args.userId) {
    return { ok: false, status: 404, body: { error: "job_not_found" } };
  }
  if (!jobEligibleForPurchaseDecision(job)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "job_not_awaiting_purchase_decision",
        jobStatus: job.status,
      },
    };
  }

  const priorScope = scopeRecord(job) ?? {};
  const scopeSearched = {
    ...priorScope,
    acquisitionDeclined: true,
    finishReason: "header-only",
  };

  await db
    .update(recordsRequestJobs)
    .set({
      status: "complete",
      scopeSearched,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recordsRequestJobs.id, args.jobId),
        eq(recordsRequestJobs.userId, args.userId),
      ),
    );

  const updated = await loadRecordsRequestJobById(args.jobId);
  if (!updated) {
    return { ok: false, status: 500, body: { error: "job_reload_failed" } };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ...recordsRequestJobToWire(updated),
      finishReason: "header-only",
    },
  };
}
