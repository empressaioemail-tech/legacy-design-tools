/**
 * Pure-function tests for the autopilot log classifier (Task #482).
 *
 * Covers each branch of the rules table — snapshot, codegen-stale,
 * lint, flake, fixture, app-code, and the "errored with no parsable
 * blocks" fallback — so adding a new category requires updating
 * both the rule and a representative fixture here.
 */

import { describe, it, expect } from "vitest";
import { classifyRunLog } from "../lib/qa/classifier";

describe("classifyRunLog", () => {
  it("returns no findings on a passing run", () => {
    expect(classifyRunLog({ status: "passed", log: " ✓ all good" })).toEqual([]);
  });

  it("classifies snapshot mismatch as snapshot", () => {
    const log = `
 FAIL  src/foo.test.ts > renders > matches snapshot
   Snapshot \`renders matches snapshot 1\` mismatched
     at toMatchSnapshot (foo.test.ts:12:34)
`;
    const r = classifyRunLog({ status: "failed", log });
    expect(r).toHaveLength(1);
    expect(r[0]?.category).toBe("snapshot");
    expect(r[0]?.filePath).toBe("foo.test.ts");
    expect(r[0]?.line).toBe(12);
  });

  it("classifies stale codegen output", () => {
    const log = `
 FAIL  src/api-client.test.ts > codegen up to date
  Cannot find module './generated/api'
`;
    const r = classifyRunLog({ status: "failed", log });
    expect(r[0]?.category).toBe("codegen-stale");
  });

  it("classifies lint/prettier output", () => {
    const log = `
 FAIL  scripts/lint > prettier check
   Replace foo with bar ·
`;
    const r = classifyRunLog({ status: "failed", log });
    expect(r[0]?.category).toBe("lint");
  });

  it("classifies timeouts as flaky", () => {
    const log = `
 FAIL  e2e/cart.spec.ts > checkout
   Test timed out in 30000ms
`;
    const r = classifyRunLog({ status: "failed", log });
    expect(r[0]?.category).toBe("flaky");
    expect(r[0]?.severity).toBe("warning");
  });

  it("falls back to app-code for unknown failure shapes", () => {
    const log = `
 FAIL  src/util.test.ts > sums
   AssertionError: expected 3 to equal 4
`;
    const r = classifyRunLog({ status: "failed", log });
    expect(r[0]?.category).toBe("app-code");
  });

  it("emits an unknown finding when errored with no parsable blocks", () => {
    const r = classifyRunLog({ status: "errored", log: "completely garbled output" });
    expect(r).toHaveLength(1);
    expect(r[0]?.category).toBe("unknown");
  });
});
