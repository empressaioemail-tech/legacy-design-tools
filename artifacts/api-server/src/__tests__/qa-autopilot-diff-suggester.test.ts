/**
 * Unit tests for the autopilot diff suggester (Task #483).
 *
 * The mock branch must be deterministic and the override hook must
 * route every call through the test stub — these are the safety
 * guarantees the autopilot orchestrator relies on.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  resolveDiffSuggesterMode,
  setDiffSuggesterForTests,
  suggestDiffForFinding,
} from "../lib/qa/diffSuggester";
import type { ClassifiedFinding } from "../lib/qa/classifier";

function makeFinding(
  overrides: Partial<ClassifiedFinding> = {},
): ClassifiedFinding {
  return {
    testName: "sums",
    filePath: "src/util.ts",
    line: 12,
    errorExcerpt: "AssertionError: expected 3 to equal 4",
    category: "app-code",
    severity: "error",
    plainSummary: "test failure",
    ...overrides,
  };
}

afterEach(() => {
  setDiffSuggesterForTests(null);
  delete process.env["AIR_AUTOPILOT_DIFF_MODE"];
});

describe("resolveDiffSuggesterMode", () => {
  it("defaults to mock", () => {
    delete process.env["AIR_AUTOPILOT_DIFF_MODE"];
    expect(resolveDiffSuggesterMode()).toBe("mock");
  });

  it("returns anthropic when env var is set", () => {
    process.env["AIR_AUTOPILOT_DIFF_MODE"] = "anthropic";
    expect(resolveDiffSuggesterMode()).toBe("anthropic");
  });

  it("falls back to mock for any other value", () => {
    process.env["AIR_AUTOPILOT_DIFF_MODE"] = "openai";
    expect(resolveDiffSuggesterMode()).toBe("mock");
  });
});

describe("suggestDiffForFinding (mock branch)", () => {
  it("returns an empty string by default — never fabricates a fake patch", async () => {
    const diff = await suggestDiffForFinding(makeFinding());
    expect(diff).toBe("");
  });

  it("returns empty even when file/line metadata are missing", async () => {
    const diff = await suggestDiffForFinding(
      makeFinding({ filePath: null, line: null }),
    );
    expect(diff).toBe("");
  });
});

describe("setDiffSuggesterForTests", () => {
  it("routes every call through the override", async () => {
    const calls: ClassifiedFinding[] = [];
    setDiffSuggesterForTests(async (f) => {
      calls.push(f);
      return "--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1 +1 @@\n-foo\n+bar\n";
    });
    const out = await suggestDiffForFinding(makeFinding());
    expect(out).toContain("--- a/src/util.ts");
    expect(out).toContain("+bar");
    expect(calls).toHaveLength(1);
  });

  it("clears the override when passed null", async () => {
    setDiffSuggesterForTests(async () => "stub");
    setDiffSuggesterForTests(null);
    const out = await suggestDiffForFinding(makeFinding());
    expect(out).toBe("");
  });
});
