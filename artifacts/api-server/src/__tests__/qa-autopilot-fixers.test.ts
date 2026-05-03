/**
 * Allow-list tests for the autopilot safe fixers (Task #482).
 *
 * We don't shell out to real `pnpm` / `vitest` here — these tests
 * pin down the predicate gates so any future change to the
 * `appliesTo` shape is caught: only snapshot-only failures may
 * trigger snapshot-update, only codegen-stale findings unlock
 * codegen-regen, etc.
 */

import { describe, it, expect } from "vitest";
import { SAFE_FIXERS, pickFixers } from "../lib/qa/fixers";
import type { ClassifiedFinding } from "../lib/qa/classifier";
import type { QaSuite } from "../lib/qa/suites";

const vitestSuite: QaSuite = {
  id: "demo",
  label: "Demo",
  kind: "vitest",
  command: "pnpm",
  args: ["test"],
  description: "",
};
const playwrightSuite: QaSuite = {
  ...vitestSuite,
  kind: "playwright",
};

function finding(overrides: Partial<ClassifiedFinding>): ClassifiedFinding {
  return {
    testName: null,
    filePath: null,
    line: null,
    errorExcerpt: "",
    category: "app-code",
    severity: "error",
    plainSummary: "",
    ...overrides,
  };
}

describe("pickFixers", () => {
  it("does nothing when there are no findings", () => {
    expect(pickFixers(vitestSuite, [])).toEqual([]);
  });

  it("snapshot-update only triggers when ALL findings are snapshot-category", () => {
    const ids = pickFixers(vitestSuite, [
      finding({ category: "snapshot" }),
      finding({ category: "snapshot" }),
    ]).map((f) => f.id);
    expect(ids).toContain("snapshot-update");

    // Mixed → snapshot fixer must NOT run (would mask a real bug).
    const mixed = pickFixers(vitestSuite, [
      finding({ category: "snapshot" }),
      finding({ category: "app-code" }),
    ]).map((f) => f.id);
    expect(mixed).not.toContain("snapshot-update");
  });

  it("snapshot-update never runs against playwright suites", () => {
    const ids = pickFixers(playwrightSuite, [
      finding({ category: "snapshot" }),
    ]).map((f) => f.id);
    expect(ids).not.toContain("snapshot-update");
  });

  it("codegen-regen triggers only when at least one finding is codegen-stale", () => {
    expect(
      pickFixers(vitestSuite, [finding({ category: "app-code" })]).map((f) => f.id),
    ).not.toContain("codegen-regen");
    expect(
      pickFixers(vitestSuite, [finding({ category: "codegen-stale" })]).map(
        (f) => f.id,
      ),
    ).toContain("codegen-regen");
  });

  it("prettier-format triggers on lint findings", () => {
    expect(
      pickFixers(vitestSuite, [finding({ category: "lint" })]).map((f) => f.id),
    ).toContain("prettier-format");
  });

  it("the allow-list never grows accidentally — only three safe fixers exist", () => {
    expect(SAFE_FIXERS.map((f) => f.id).sort()).toEqual(
      ["codegen-regen", "prettier-format", "snapshot-update"].sort(),
    );
  });
});
