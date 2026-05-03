/**
 * Orchestration-level tests for populateSuggestedDiffs (Task #483).
 *
 * Verifies that:
 *   - app-code (and unknown) findings get a real suggestedDiff
 *     persisted via the writer.
 *   - Auto-fix-eligible categories (snapshot, codegen-stale, lint,
 *     fixture, flaky) are skipped — those have a dedicated fixer.
 *   - Findings that already carry a suggestedDiff are not overwritten.
 *   - When the suggester returns "" no row is touched (mock-mode
 *     default behaviour: no fake patches).
 *   - Errors thrown by the suggester are swallowed — orchestration
 *     keeps moving and other findings still get processed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { populateSuggestedDiffs } from "../lib/qa/autopilot";
import { setDiffSuggesterForTests } from "../lib/qa/diffSuggester";
import type { ClassifiedFinding } from "../lib/qa/classifier";
import type {
  AutopilotFinding,
  AutopilotFindingCategory,
} from "@workspace/db";

afterEach(() => {
  setDiffSuggesterForTests(null);
});

function row(
  id: string,
  category: AutopilotFindingCategory,
  overrides: Partial<AutopilotFinding> = {},
): AutopilotFinding {
  return {
    id,
    autopilotRunId: "run-1",
    suiteId: "demo",
    qaRunId: null,
    testName: null,
    filePath: "src/foo.ts",
    line: 1,
    errorExcerpt: "boom",
    category,
    severity: "error",
    autoFixStatus: "needs-review",
    plainSummary: "",
    suggestedDiff: "",
    createdAt: new Date(),
    ...overrides,
  };
}

function classified(
  overrides: Partial<ClassifiedFinding> = {},
): ClassifiedFinding {
  return {
    testName: null,
    filePath: "src/foo.ts",
    line: 1,
    errorExcerpt: "boom",
    category: "app-code",
    severity: "error",
    plainSummary: "",
    ...overrides,
  };
}

describe("populateSuggestedDiffs", () => {
  it("persists a real diff for app-code findings via the writer", async () => {
    setDiffSuggesterForTests(async () => "--- a/x\n+++ b/x\n@@\n-a\n+b\n");
    const writes: Array<{ id: string; diff: string }> = [];
    await populateSuggestedDiffs(
      [row("f1", "app-code")],
      [classified()],
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    expect(writes).toEqual([
      { id: "f1", diff: "--- a/x\n+++ b/x\n@@\n-a\n+b\n" },
    ]);
  });

  it("also persists for `unknown`-category findings", async () => {
    setDiffSuggesterForTests(async () => "--- a/x\n+++ b/x\n@@\n");
    const writes: Array<{ id: string; diff: string }> = [];
    await populateSuggestedDiffs(
      [row("f1", "unknown")],
      [classified({ category: "unknown" })],
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    expect(writes.map((w) => w.id)).toEqual(["f1"]);
  });

  it("skips auto-fix-eligible categories so we don't shadow the fixer", async () => {
    let called = 0;
    setDiffSuggesterForTests(async () => {
      called += 1;
      return "diff";
    });
    const writes: Array<{ id: string; diff: string }> = [];
    const cats = [
      "snapshot",
      "codegen-stale",
      "lint",
      "fixture",
      "flaky",
    ] as const;
    const persisted: AutopilotFinding[] = cats.map((c, i) =>
      row(`f-${i}`, c),
    );
    await populateSuggestedDiffs(
      persisted,
      cats.map((c) => classified({ category: c })),
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    expect(called).toBe(0);
    expect(writes).toEqual([]);
  });

  it("never persists an empty diff (mock-mode default)", async () => {
    setDiffSuggesterForTests(async () => "");
    const writes: Array<{ id: string; diff: string }> = [];
    await populateSuggestedDiffs(
      [row("f1", "app-code")],
      [classified()],
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    expect(writes).toEqual([]);
  });

  it("preserves an existing suggestedDiff (does not overwrite)", async () => {
    setDiffSuggesterForTests(async () => "NEW DIFF");
    const writes: Array<{ id: string; diff: string }> = [];
    await populateSuggestedDiffs(
      [row("f1", "app-code", { suggestedDiff: "PRE-EXISTING" })],
      [classified()],
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    expect(writes).toEqual([]);
  });

  it("swallows suggester errors and keeps processing other findings", async () => {
    let n = 0;
    setDiffSuggesterForTests(async () => {
      n += 1;
      if (n === 1) throw new Error("LLM down");
      return "--- a/x\n+++ b/x\n@@\n-a\n+b\n";
    });
    const writes: Array<{ id: string; diff: string }> = [];
    await populateSuggestedDiffs(
      [row("f1", "app-code"), row("f2", "app-code")],
      [classified(), classified()],
      { writeDiff: async (id, diff) => void writes.push({ id, diff }) },
    );
    // f1 errored — no write; f2 succeeded — one write.
    expect(writes.map((w) => w.id)).toEqual(["f2"]);
  });
});
