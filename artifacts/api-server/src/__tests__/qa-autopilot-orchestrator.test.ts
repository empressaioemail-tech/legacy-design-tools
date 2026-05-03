/**
 * Task #485 — QA autopilot orchestrator end-to-end integration test.
 *
 * The unit suites (qa-autopilot-classifier, qa-autopilot-fixers) cover
 * the pure-function pieces; this file locks in the orchestrator's
 * behavior across the full flake-retry → classify → safe-fix → verify
 * loop, using mocked QaSuites so no real test runner ever spawns.
 *
 * Scenarios:
 *   - clean run                       — every suite passes first try
 *   - flake-retry-success             — fail-then-pass marks flaky, no needs-review
 *   - fix-and-verify-success          — fixer applies, re-run green → auto-fixed
 *   - fix-and-verify-fails-revert     — fixer applies, re-run still red → revert
 *   - concurrency guard               — second start while one in flight throws
 *
 * The runner module (`./runner`) is replaced with a programmable queue
 * keyed by suite id, and the fixers module (`./fixers`) is replaced
 * with whatever fake fixer the test installs in `h.fixers`. The DB
 * accessor is proxied to the per-file test schema so the actual
 * `autopilot_runs` / `autopilot_findings` / `autopilot_fix_actions`
 * rows the orchestrator writes can be asserted on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { ctx } from "./test-context";
import type { QaSuite } from "../lib/qa/suites";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("qa-autopilot-orchestrator.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const h = vi.hoisted(() => {
  type RunnerCall = {
    status: "passed" | "failed" | "errored";
    log: string;
  };
  type FakeFixer = {
    id: string;
    description: string;
    appliesTo?: () => boolean;
    apply: (suite: unknown) => Promise<{
      filesChanged: string[];
      command: string;
      log: string;
      success: boolean;
    }>;
  };
  return {
    runnerQueueBySuite: new Map<string, RunnerCall[]>(),
    runnerCalls: [] as Array<{ suiteId: string }>,
    runnerHook: null as
      | null
      | ((suiteId: string, callIndex: number) => Promise<void>),
    fixers: [] as FakeFixer[],
    reverted: [] as string[][],
  };
});

vi.mock("../lib/qa/runner", () => ({
  QA_REPO_ROOT: "/tmp",
  runSuiteToCompletion: vi.fn(async (suite: { id: string }) => {
    const callIndex = h.runnerCalls.filter(
      (c) => c.suiteId === suite.id,
    ).length;
    h.runnerCalls.push({ suiteId: suite.id });
    if (h.runnerHook) await h.runnerHook(suite.id, callIndex);
    const queue = h.runnerQueueBySuite.get(suite.id) ?? [];
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `runSuiteToCompletion mock: no scripted outcome left for ${suite.id} (call #${callIndex})`,
      );
    }
    return {
      runId: randomUUID(),
      outcome: {
        status: next.status,
        exitCode: next.status === "passed" ? 0 : 1,
        durationMs: 1,
        log: next.log,
      },
    };
  }),
}));

vi.mock("../lib/qa/fixers", () => ({
  pickFixers: vi.fn(() => h.fixers),
  gitRevertPaths: vi.fn(async (paths: string[]) => {
    h.reverted.push([...paths]);
  }),
}));

const { setupRouteTests } = await import("./setup");
const {
  startAutopilotRun,
  getActiveAutopilotRunId,
  getAutopilotRunDetail,
  AutopilotAlreadyRunningError,
} = await import("../lib/qa/autopilot");

setupRouteTests(() => {});

const fakeSuite: QaSuite = {
  id: "fake-suite",
  app: "api-server",
  kind: "vitest",
  label: "Fake Suite",
  command: "true",
  args: [],
  description: "Mock suite for orchestrator integration tests",
};

const codegenFailureLog =
  " FAIL  src/foo.test.ts > my test\n  Cannot find module 'generated/api'\n";
const flakeFailureLog =
  " FAIL  src/foo.test.ts > my test\n  Test timed out after 5000ms\n";

beforeEach(() => {
  h.runnerQueueBySuite.clear();
  h.runnerCalls.length = 0;
  h.runnerHook = null;
  h.fixers = [];
  h.reverted.length = 0;
});

async function waitForRunComplete(runId: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const detail = await getAutopilotRunDetail(runId);
    if (detail && detail.run.status !== "running") return detail;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`autopilot run ${runId} did not complete within ${timeoutMs}ms`);
}

describe("autopilot orchestrator (integration)", () => {
  it("clean run: passing suite → completed, no findings, no fix actions", async () => {
    h.runnerQueueBySuite.set(fakeSuite.id, [{ status: "passed", log: "ok\n" }]);

    const { runId } = await startAutopilotRun("manual", [fakeSuite]);
    const detail = await waitForRunComplete(runId);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.totalSuites).toBe(1);
    expect(detail.run.passing).toBe(1);
    expect(detail.run.failing).toBe(0);
    expect(detail.run.flaky).toBe(0);
    expect(detail.run.autoFixesApplied).toBe(0);
    expect(detail.run.needsReview).toBe(0);
    expect(detail.findings).toHaveLength(0);
    expect(detail.fixActions).toHaveLength(0);
    expect(h.runnerCalls).toHaveLength(1);
  });

  it("flake-retry-success: fail-then-pass increments flaky, suppresses needs-review", async () => {
    h.runnerQueueBySuite.set(fakeSuite.id, [
      { status: "failed", log: flakeFailureLog },
      { status: "passed", log: "ok\n" },
    ]);

    const { runId } = await startAutopilotRun("manual", [fakeSuite]);
    const detail = await waitForRunComplete(runId);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.flaky).toBe(1);
    expect(detail.run.failing).toBe(0);
    expect(detail.run.passing).toBe(0);
    expect(detail.run.needsReview).toBe(0);
    expect(detail.run.autoFixesApplied).toBe(0);
    expect(detail.run.notes).toContain("flaky");
    // Findings persisted with the informational `skipped` status, all
    // recategorized as `flaky` per runWithFlakeRetry's mapping.
    expect(detail.findings.length).toBeGreaterThan(0);
    for (const f of detail.findings) {
      expect(f.autoFixStatus).toBe("skipped");
      expect(f.category).toBe("flaky");
      expect(f.severity).toBe("warning");
    }
    expect(detail.fixActions).toHaveLength(0);
    expect(h.runnerCalls).toHaveLength(2);
  });

  it("fix-and-verify-success: fixer applies and verify passes → findings auto-fixed", async () => {
    h.runnerQueueBySuite.set(fakeSuite.id, [
      // Initial run + flake-retry both fail with the same codegen-stale signature.
      { status: "failed", log: codegenFailureLog },
      { status: "failed", log: codegenFailureLog },
      // Verify run after the fixer applies → green.
      { status: "passed", log: "ok\n" },
    ]);
    const changedFiles = ["lib/api-spec/generated/foo.ts"];
    h.fixers = [
      {
        id: "codegen-regen",
        description: "regen api-spec",
        apply: async () => ({
          filesChanged: changedFiles,
          command: "pnpm --filter @workspace/api-spec run codegen",
          log: "regen ok",
          success: true,
        }),
      },
    ];

    const { runId } = await startAutopilotRun("manual", [fakeSuite]);
    const detail = await waitForRunComplete(runId);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.passing).toBe(0);
    expect(detail.run.failing).toBe(0);
    expect(detail.run.needsReview).toBe(0);
    expect(detail.run.autoFixesApplied).toBeGreaterThanOrEqual(1);
    expect(detail.findings.length).toBeGreaterThan(0);
    for (const f of detail.findings) {
      expect(f.autoFixStatus).toBe("auto-fixed");
      expect(f.category).toBe("codegen-stale");
    }
    expect(detail.fixActions).toHaveLength(1);
    const action = detail.fixActions[0]!;
    expect(action.success).toBe(true);
    expect(action.fixerId).toBe("codegen-regen");
    expect(action.log).toContain("[verify] re-run status=passed");
    expect(JSON.parse(action.filesChanged)).toEqual(changedFiles);
    expect(h.reverted).toHaveLength(0);
    // 2 (flake-retry) + 1 (verify) = 3 runner calls.
    expect(h.runnerCalls).toHaveLength(3);
  });

  it("fix-and-verify-fails-revert: fixer applies but verify still fails → revert + needs-review", async () => {
    h.runnerQueueBySuite.set(fakeSuite.id, [
      { status: "failed", log: codegenFailureLog },
      { status: "failed", log: codegenFailureLog },
      { status: "failed", log: codegenFailureLog },
    ]);
    const changedFiles = ["lib/api-spec/generated/foo.ts"];
    h.fixers = [
      {
        id: "codegen-regen",
        description: "regen api-spec",
        apply: async () => ({
          filesChanged: changedFiles,
          command: "pnpm --filter @workspace/api-spec run codegen",
          log: "regen ok",
          success: true,
        }),
      },
    ];

    const { runId } = await startAutopilotRun("manual", [fakeSuite]);
    const detail = await waitForRunComplete(runId);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.failing).toBe(1);
    expect(detail.run.autoFixesApplied).toBe(0);
    expect(detail.run.needsReview).toBeGreaterThanOrEqual(1);
    expect(detail.findings.length).toBeGreaterThan(0);
    for (const f of detail.findings) {
      expect(f.autoFixStatus).toBe("needs-review");
    }
    expect(detail.fixActions).toHaveLength(1);
    const action = detail.fixActions[0]!;
    expect(action.success).toBe(false);
    expect(action.log).toContain("reverted");
    // The orchestrator should have asked the fixer module to roll back
    // exactly the files the fixer reported touching.
    expect(h.reverted).toEqual([changedFiles]);
    expect(h.runnerCalls).toHaveLength(3);
  });

  it("concurrency guard: a second start while one is in flight throws AutopilotAlreadyRunningError", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Block the very first runner call until the test releases the gate
    // so the in-flight orchestration window stays open across the
    // concurrency assertion.
    h.runnerHook = async (_suiteId, callIndex) => {
      if (callIndex === 0) await gate;
    };
    h.runnerQueueBySuite.set(fakeSuite.id, [{ status: "passed", log: "ok\n" }]);

    const { runId: firstId } = await startAutopilotRun("manual", [fakeSuite]);
    expect(getActiveAutopilotRunId()).toBe(firstId);

    await expect(
      startAutopilotRun("manual", [fakeSuite]),
    ).rejects.toBeInstanceOf(AutopilotAlreadyRunningError);

    release();
    const detail = await waitForRunComplete(firstId);
    expect(detail.run.status).toBe("completed");
    expect(getActiveAutopilotRunId()).toBeNull();
  });
});
