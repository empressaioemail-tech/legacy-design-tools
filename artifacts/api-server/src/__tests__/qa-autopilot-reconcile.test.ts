/**
 * Boot-time reconciliation + DB-backed active-run guard.
 *
 * Exercises the orphan-cleanup path that runs on API server startup,
 * plus the post-restart concurrency guard that consults the
 * `autopilot_runs` table as the sole source of truth. The runner is
 * stubbed so no real test subprocess spawns — we only care about the
 * row-level state transitions here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("qa-autopilot-reconcile.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/qa/runner", () => ({
  QA_REPO_ROOT: "/tmp",
  runSuiteToCompletion: vi.fn(async () => ({
    runId: "00000000-0000-0000-0000-000000000000",
    outcome: {
      status: "passed" as const,
      exitCode: 0,
      durationMs: 1,
      log: "",
    },
  })),
}));

const { setupRouteTests } = await import("./setup");
const {
  reconcileOrphanedAutopilotRuns,
  getActiveAutopilotRunId,
  startAutopilotRun,
  AutopilotAlreadyRunningError,
} = await import("../lib/qa/autopilot");
const { autopilotRuns, autopilotFixActions } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

setupRouteTests(() => {});

beforeEach(() => {
  // Each test inserts its own seed rows; the truncate hook in setup
  // wipes the autopilot tables between cases.
});

describe("autopilot boot-time reconciliation", () => {
  it("flips orphaned `running` rows to `errored` and stamps in-flight fix actions", async () => {
    const db = ctx.schema!.db;
    const [orphan] = await db
      .insert(autopilotRuns)
      .values({
        status: "running",
        trigger: "manual",
        startedAt: new Date(Date.now() - 60_000),
        totalSuites: 2,
      })
      .returning();
    if (!orphan) throw new Error("seed insert returned no row");
    await db.insert(autopilotFixActions).values({
      autopilotRunId: orphan.id,
      fixerId: "snapshot-update",
      suiteId: "fake",
      command: "noop",
      filesChanged: "[]",
      success: false,
      // finishedAt deliberately left null — simulates a fixer in flight
      // when the server died.
    });

    const reconciled = await reconcileOrphanedAutopilotRuns();
    expect(reconciled).toBe(1);

    const [after] = await db
      .select()
      .from(autopilotRuns)
      .where(eq(autopilotRuns.id, orphan.id));
    expect(after!.status).toBe("errored");
    expect(after!.finishedAt).not.toBeNull();
    expect(after!.notes).toContain("abandoned by server restart");

    const fixActions = await db
      .select()
      .from(autopilotFixActions)
      .where(eq(autopilotFixActions.autopilotRunId, orphan.id));
    expect(fixActions[0]!.finishedAt).not.toBeNull();

    // After reconciliation the active-run query reads clean.
    expect(await getActiveAutopilotRunId()).toBeNull();
  });

  it("is a no-op when there are no `running` rows", async () => {
    expect(await reconcileOrphanedAutopilotRuns()).toBe(0);
  });

  it("DB-backed guard: startAutopilotRun rejects when a stale `running` row exists after a restart", async () => {
    const db = ctx.schema!.db;
    // Simulate the post-restart state: a row left as `running` from
    // the previous process. The DB-backed guard must still trip.
    const [stale] = await db
      .insert(autopilotRuns)
      .values({
        status: "running",
        trigger: "manual",
        startedAt: new Date(Date.now() - 60_000),
        totalSuites: 1,
      })
      .returning();
    if (!stale) throw new Error("seed insert returned no row");

    expect(await getActiveAutopilotRunId()).toBe(stale.id);

    await expect(startAutopilotRun("manual", [])).rejects.toBeInstanceOf(
      AutopilotAlreadyRunningError,
    );

    // After reconciliation a fresh start is allowed.
    await reconcileOrphanedAutopilotRuns();
    expect(await getActiveAutopilotRunId()).toBeNull();
    const result = await startAutopilotRun("manual", []);
    expect(result.runId).toBeTruthy();
  });
});
