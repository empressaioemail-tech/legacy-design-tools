import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  approveRecordsRequestPurchase,
  declineRecordsRequestPurchase,
  jobEligibleForPurchaseDecision,
} from "../recordsRequestPurchaseDecision";

const mockLoad = vi.fn();
const mockUpdate = vi.fn();
const mockLaunch = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdate(...args),
      }),
    }),
  },
  recordsRequestJobs: { id: "id", userId: "userId" },
}));

vi.mock("../recordsRequestJobWorker", () => ({
  loadRecordsRequestJobById: (...args: unknown[]) => mockLoad(...args),
  recordsRequestJobToWire: (job: Record<string, unknown>) => ({
    jobId: job.id,
    jobStatus: job.status,
    status: job.status,
  }),
  buildRecordsRequestWorkerLaunch: () => mockLaunch,
}));

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const pausedJob = {
  id: JOB_ID,
  userId: USER_ID,
  status: "awaiting-purchase-approval" as const,
  errorCode: "awaiting-purchase-approval",
  errorMessage: "Portal purchase path detected",
  requestPayload: {},
  scopeSearched: {
    indexHits: [{ recordingRef: "2020-1" }],
    acquisition: { pendingPurchaseCount: 2, purchaseCostCents: 700 },
    awaitingPurchaseApproval: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue(undefined);
});

describe("jobEligibleForPurchaseDecision", () => {
  it("accepts awaiting-purchase-approval with pending purchases", () => {
    expect(jobEligibleForPurchaseDecision(pausedJob as never)).toBe(true);
  });

  it("rejects complete jobs", () => {
    expect(
      jobEligibleForPurchaseDecision({
        ...pausedJob,
        status: "complete",
      } as never),
    ).toBe(false);
  });
});

describe("approveRecordsRequestPurchase", () => {
  it("requeues job and launches worker", async () => {
    mockLoad
      .mockResolvedValueOnce(pausedJob)
      .mockResolvedValueOnce({
        ...pausedJob,
        status: "queued",
        requestPayload: { purchaseApproved: true },
      });

    const result = await approveRecordsRequestPurchase({
      jobId: JOB_ID,
      userId: USER_ID,
      launch: mockLaunch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(mockLaunch).toHaveBeenCalledWith(JOB_ID);
  });

  it("404s when job not owned by user", async () => {
    mockLoad.mockResolvedValueOnce({ ...pausedJob, userId: "other" });
    const result = await approveRecordsRequestPurchase({
      jobId: JOB_ID,
      userId: USER_ID,
    });
    expect(result.status).toBe(404);
  });
});

describe("declineRecordsRequestPurchase", () => {
  it("completes job header-only", async () => {
    mockLoad
      .mockResolvedValueOnce(pausedJob)
      .mockResolvedValueOnce({
        ...pausedJob,
        status: "complete",
        scopeSearched: {
          ...pausedJob.scopeSearched,
          acquisitionDeclined: true,
          finishReason: "header-only",
        },
      });

    const result = await declineRecordsRequestPurchase({
      jobId: JOB_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.finishReason).toBe("header-only");
  });
});
