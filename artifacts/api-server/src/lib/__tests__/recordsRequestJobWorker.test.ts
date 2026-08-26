/**
 * Unit tests for recordsRequestJobWorker enqueue + single-flight guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDbState {
  selectRows: Array<Record<string, unknown>>;
  insertedRows: Array<Record<string, unknown>>;
  insertShouldThrowUnique: boolean;
}

const fakeState: FakeDbState = {
  selectRows: [],
  insertedRows: [],
  insertShouldThrowUnique: false,
};

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain["from"] = passthrough;
  chain["where"] = passthrough;
  chain["orderBy"] = passthrough;
  chain["limit"] = async () => fakeState.selectRows;
  return chain;
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {};
  chain["values"] = (row: Record<string, unknown>) => {
    if (fakeState.insertShouldThrowUnique) {
      const err = new Error("unique violation") as Error & { code: string };
      err.code = "23505";
      throw err;
    }
    fakeState.insertedRows.push(row);
    return chain;
  };
  chain["returning"] = async () => [{ id: "job-inserted" }];
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
  },
  recordsRequestJobs: {
    id: "id",
    engagementId: "engagement_id",
    userId: "user_id",
    status: "status",
    createdAt: "created_at",
  },
}));

const LIVE_GIS_AUDIT = {
  queriedAt: "2026-08-26T12:00:00.000Z",
  parcelKey: "apn:48453:TEST",
  countyFips: "48453",
  layers: [],
  hits: [],
};

describe("recordsRequestJobWorker", () => {
  beforeEach(() => {
    fakeState.selectRows = [];
    fakeState.insertedRows = [];
    fakeState.insertShouldThrowUnique = false;
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a queued row with liveInstantGis before launch", async () => {
    const launch = vi.fn();
    const { enqueueRecordsRequestJob } = await import("../recordsRequestJobWorker");

    const result = await enqueueRecordsRequestJob({
      engagementId: "eng-1",
      userId: "user-1",
      parcelKey: "apn:48453:TEST",
      countyFips: "48453",
      liveInstantGis: LIVE_GIS_AUDIT,
      launch,
    });

    expect(result).toEqual({
      kind: "queued",
      jobId: "job-inserted",
      alreadyInFlight: false,
    });
    expect(fakeState.insertedRows).toHaveLength(1);
    expect(fakeState.insertedRows[0]).toMatchObject({
      status: "queued",
      liveInstantGis: LIVE_GIS_AUDIT,
      parcelKey: "apn:48453:TEST",
      countyFips: "48453",
    });
    expect(launch).toHaveBeenCalledWith("job-inserted");
  });

  it("returns the active job on single-flight loss", async () => {
    fakeState.insertShouldThrowUnique = true;
    fakeState.selectRows = [
      {
        id: "existing-job",
        status: "running",
        engagementId: "eng-1",
        userId: "user-1",
      },
    ];

    const launch = vi.fn();
    const { enqueueRecordsRequestJob } = await import("../recordsRequestJobWorker");

    const result = await enqueueRecordsRequestJob({
      engagementId: "eng-1",
      userId: "user-1",
      parcelKey: "apn:48453:TEST",
      countyFips: "48453",
      liveInstantGis: LIVE_GIS_AUDIT,
      launch,
    });

    expect(result).toEqual({
      kind: "already_in_flight",
      jobId: "existing-job",
      alreadyInFlight: true,
    });
    expect(launch).not.toHaveBeenCalled();
  });
});
