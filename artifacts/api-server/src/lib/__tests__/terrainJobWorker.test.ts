/**
 * Unit tests for the async parcel-terrain worker (`terrainJobWorker.ts`).
 *
 * These are PURE unit tests — `@workspace/db` and the heavy ingest
 * (`./siteTopographyIngest`) are mocked, so they run with no external Postgres
 * (unlike the schema-backed sweep/ingest integration suites). They pin the two
 * behaviors the terrain-worker fix hardens:
 *
 *   1. runTerrainJob claims a `queued` row (compare-and-set to `generating`),
 *      runs the ingest, and drives the row to a terminal state on success.
 *   2. When the ingest THROWS, runTerrainJob catches it and stamps the row
 *      `status: "failed"` — it never leaves the row stuck (the prod symptom
 *      being fixed: the poll would otherwise hang forever with zero worker
 *      logs).
 *
 * Plus the diagnosability guarantees added by the fix:
 *   3. runTerrainJob logs on ENTRY, before any throwable setup.
 *   4. The fire-and-forget launch attaches a `.catch()` (no swallowed
 *      rejection).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────
// A tiny in-memory fake of the drizzle `db` surface the worker touches:
//   - db.select().from(t).where(...).orderBy?(...).limit(n)  -> rows
//   - db.insert(t).values(v).returning(cols)                 -> inserted
//   - db.update(t).set(patch).where(...).returning?(cols)    -> updated
// Each `update(...).set(...)` records the patch so tests can assert the
// status transitions the worker drove.
// ─────────────────────────────────────────────────────────────────────

interface FakeDbState {
  /** Rows returned by the next `select(...).limit()` call. */
  selectRows: Array<Record<string, unknown>>;
  /** Rows returned by the next claim `update(...).returning()` call. */
  claimReturning: Array<Record<string, unknown>>;
  /** Every `.set(patch)` the worker issued, in order. */
  setPatches: Array<Record<string, unknown>>;
  /** How many `update(...)` chains were opened. */
  updateCount: number;
}

const fakeState: FakeDbState = {
  selectRows: [],
  claimReturning: [],
  setPatches: [],
  updateCount: 0,
};

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain["from"] = passthrough;
  chain["where"] = passthrough;
  chain["orderBy"] = passthrough;
  chain["innerJoin"] = passthrough;
  // `.limit(n)` terminates the read chain and resolves to the seeded rows.
  chain["limit"] = async () => fakeState.selectRows;
  return chain;
}

function makeUpdateChain() {
  fakeState.updateCount += 1;
  let recordedPatch: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  chain["set"] = (patch: Record<string, unknown>) => {
    recordedPatch = patch;
    fakeState.setPatches.push(patch);
    return chain;
  };
  // `.where(...)` may be the terminal await (terminal stamps) OR be followed by
  // `.returning(...)` (the claim). Make the chain itself awaitable so a bare
  // `await db.update().set().where()` resolves, and expose `.returning()` for
  // the claim path.
  chain["where"] = () => chain;
  chain["returning"] = async () => fakeState.claimReturning;
  // Thenable: `await db.update(...).set(...).where(...)` resolves here.
  chain["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(recordedPatch).then(resolve);
  return chain;
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {};
  chain["values"] = () => chain;
  chain["returning"] = async () => [{ id: "job-inserted" }];
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => makeSelectChain(),
    insert: () => makeInsertChain(),
    update: () => makeUpdateChain(),
  },
  // The worker only references `terrainGenerationJobs` as a table token for the
  // drizzle helpers (eq/and/inArray/desc), which are no-ops against our fake.
  terrainGenerationJobs: {
    id: "id",
    engagementId: "engagement_id",
    status: "status",
    createdAt: "created_at",
  },
}));

// NOTE: `drizzle-orm` is intentionally NOT mocked. Its operators (eq/and/…) are
// pure token builders whose output the fake `db` above ignores, and mocking the
// whole module would break transitive consumers (e.g. `@hauska/atom-contract`
// imports `sql` from it). Keeping the real module is both correct and simpler.

// Mock the heavy ingest — its behavior is injected per-test.
const ingestMock = vi.fn();
vi.mock("../siteTopographyIngest", () => ({
  ingestSiteTopography: (args: unknown) => ingestMock(args),
}));

// A no-op history service so the worker's `getHistoryService()` default is never
// exercised (we always inject `deps.history`).
const fakeHistory = {} as never;

const { runTerrainJob } = await import("../terrainJobWorker");

// Silent logger capturing entry/transition lines for assertion.
function makeLog() {
  const messages: string[] = [];
  const rec =
    () =>
    (_obj: unknown, msg?: string): void => {
      if (msg) messages.push(msg);
    };
  return {
    messages,
    info: rec(),
    warn: rec(),
    error: rec(),
    debug: rec(),
    fatal: rec(),
    trace: rec(),
  } as never;
}

const QUEUED_JOB = {
  id: "job-1",
  engagementId: "eng-1",
  status: "queued",
  requestPayload: { contourIntervalMeters: 5 },
};

beforeEach(() => {
  fakeState.selectRows = [];
  fakeState.claimReturning = [];
  fakeState.setPatches = [];
  fakeState.updateCount = 0;
  ingestMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runTerrainJob", () => {
  it("logs on entry before any throwable setup", async () => {
    // Job row not found — the worker returns early, but the ENTRY log must
    // already have fired (this is the diagnosability guarantee: 'worker
    // started' must appear even on the earliest exit paths).
    fakeState.selectRows = [];
    const log = makeLog();

    await runTerrainJob("job-missing", { history: fakeHistory, log });

    expect((log as unknown as { messages: string[] }).messages[0]).toBe(
      "terrain job: worker started",
    );
  });

  it("claims a queued row (queued -> generating) and drives it to ready", async () => {
    fakeState.selectRows = [QUEUED_JOB];
    fakeState.claimReturning = [{ id: "job-1" }]; // claim won the compare-and-set
    ingestMock.mockResolvedValue({
      status: "ok",
      materializableElementId: "mat-1",
      reusedExisting: false,
    });
    const log = makeLog();

    await runTerrainJob("job-1", { history: fakeHistory, log });

    // First `set` is the claim -> generating; last is the terminal -> ready.
    expect(fakeState.setPatches[0]).toMatchObject({ status: "generating" });
    expect(ingestMock).toHaveBeenCalledOnce();
    const last = fakeState.setPatches[fakeState.setPatches.length - 1];
    expect(last).toMatchObject({
      status: "ready",
      materializableElementId: "mat-1",
    });
    const msgs = (log as unknown as { messages: string[] }).messages;
    expect(msgs).toContain("terrain job: worker started");
    expect(msgs).toContain(
      "terrain job: generating (claimed queued -> generating)",
    );
  });

  it("stamps status='failed' when the ingest THROWS (never leaves the row stuck)", async () => {
    fakeState.selectRows = [QUEUED_JOB];
    fakeState.claimReturning = [{ id: "job-1" }];
    ingestMock.mockRejectedValue(new Error("boom: 3DEP wedged"));
    const log = makeLog();

    // Must NOT reject — the worker catches its own failures.
    await expect(
      runTerrainJob("job-1", { history: fakeHistory, log }),
    ).resolves.toBeUndefined();

    // Claim happened, then a terminal failed stamp carrying the error.
    expect(fakeState.setPatches[0]).toMatchObject({ status: "generating" });
    const last = fakeState.setPatches[fakeState.setPatches.length - 1];
    expect(last).toMatchObject({
      status: "failed",
      errorCode: "internal_worker_error",
    });
    expect(String(last["errorMessage"])).toContain("boom: 3DEP wedged");
  });

  it("stamps status='failed' when the ingest returns upstream-error", async () => {
    fakeState.selectRows = [QUEUED_JOB];
    fakeState.claimReturning = [{ id: "job-1" }];
    ingestMock.mockResolvedValue({
      status: "upstream-error",
      code: "usgs3dep-timeout",
      reason: "USGS 3DEP timed out",
    });

    await runTerrainJob("job-1", { history: fakeHistory, log: makeLog() });

    const last = fakeState.setPatches[fakeState.setPatches.length - 1];
    expect(last).toMatchObject({
      status: "failed",
      errorCode: "usgs3dep-timeout",
    });
  });

  it("does not run the ingest when the claim is lost (another runner has it)", async () => {
    fakeState.selectRows = [QUEUED_JOB];
    fakeState.claimReturning = []; // lost the compare-and-set race
    ingestMock.mockResolvedValue({ status: "ok" });

    await runTerrainJob("job-1", { history: fakeHistory, log: makeLog() });

    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("skips a row that is already past 'queued'", async () => {
    fakeState.selectRows = [{ ...QUEUED_JOB, status: "generating" }];
    ingestMock.mockResolvedValue({ status: "ok" });

    await runTerrainJob("job-1", { history: fakeHistory, log: makeLog() });

    // No claim update issued, ingest never called.
    expect(fakeState.updateCount).toBe(0);
    expect(ingestMock).not.toHaveBeenCalled();
  });
});
