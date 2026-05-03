/**
 * Per-run watchdog timer.
 *
 * If a run exceeds the configured max-runtime budget, the watchdog
 * must flip the row to `errored` with a clear note so the next
 * "Run now" isn't blocked. We shrink the budget via
 * `_setAutopilotMaxRuntimeMsForTesting` and stall the runner so the
 * watchdog is the only thing that can resolve the row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ctx } from "./test-context";
import type { QaSuite } from "../lib/qa/suites";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("qa-autopilot-watchdog.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const h = vi.hoisted(() => ({
  release: null as null | (() => void),
  resolved: false,
}));

vi.mock("../lib/qa/runner", () => ({
  QA_REPO_ROOT: "/tmp",
  runSuiteToCompletion: vi.fn(async () => {
    // Stall forever (until the test releases). Simulates a hung suite
    // child process the orchestrator can't recover from on its own.
    await new Promise<void>((resolve) => {
      h.release = () => {
        h.resolved = true;
        resolve();
      };
    });
    return {
      runId: "00000000-0000-0000-0000-000000000000",
      outcome: {
        status: "passed" as const,
        exitCode: 0,
        durationMs: 1,
        log: "",
      },
    };
  }),
}));

vi.mock("../lib/qa/fixers", () => ({
  pickFixers: vi.fn(() => []),
  gitRevertPaths: vi.fn(async () => {}),
}));

const { setupRouteTests } = await import("./setup");
const {
  startAutopilotRun,
  getActiveAutopilotRunId,
  _setAutopilotMaxRuntimeMsForTesting,
} = await import("../lib/qa/autopilot");
const { autopilotRuns } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

setupRouteTests(() => {});

const fakeSuite: QaSuite = {
  id: "fake-suite",
  app: "api-server",
  kind: "vitest",
  label: "Fake Suite",
  command: "true",
  args: [],
  description: "Mock suite for watchdog test",
};

beforeEach(() => {
  h.release = null;
  h.resolved = false;
});

afterEach(() => {
  _setAutopilotMaxRuntimeMsForTesting(null);
  if (h.release) h.release();
});

describe("autopilot watchdog", () => {
  it("flips a run to `errored` after the max-runtime budget elapses", async () => {
    _setAutopilotMaxRuntimeMsForTesting(100);

    const { runId } = await startAutopilotRun("manual", [fakeSuite]);

    // Wait for the watchdog to fire.
    const start = Date.now();
    let row: { status: string; notes: string } | null = null;
    while (Date.now() - start < 5_000) {
      const [r] = await ctx
        .schema!.db.select()
        .from(autopilotRuns)
        .where(eq(autopilotRuns.id, runId));
      if (r && r.status === "errored") {
        row = r;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row, "expected watchdog to flip row to errored").not.toBeNull();
    expect(row!.status).toBe("errored");
    expect(row!.notes).toContain("exceeded max runtime");

    // The active-run cache must clear so a new run isn't blocked.
    expect(await getActiveAutopilotRunId()).toBeNull();

    // Release the stalled runner so the test exits cleanly.
    h.release?.();
  });
});
