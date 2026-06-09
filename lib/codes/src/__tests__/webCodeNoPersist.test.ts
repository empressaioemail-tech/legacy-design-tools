import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REASONING_ATOM_PREFIX = "reasoning:";

/**
 * v2 boundary: web fetch persists reasoning atoms (capped snippet + deeplinks),
 * NOT full verbatim section text and NOT public code_atoms catalog rows.
 */
describe("reasoning atom grounding — persist reasoning, NOT verbatim text", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  it("reasoningAtoms module documents persist-reasoning boundary", () => {
    const src = readFileSync(
      join(repoRoot, "lib/codes/src/reasoningAtoms/types.ts"),
      "utf-8",
    );
    expect(src).toContain("REASONING_SNIPPET_MAX_CHARS");
    expect(src).toContain(REASONING_ATOM_PREFIX);
    expect(src).not.toContain("fullSection");
  });

  it("web fetch entry delegates persistence to reasoningAtoms", () => {
    const src = readFileSync(
      join(repoRoot, "lib/codes/src/webCodeFetch/index.ts"),
      "utf-8",
    );
    expect(src).toContain("reasoningAtoms");
    expect(src).not.toContain("never persisted");
  });

  it("retired interim seed script is gone", () => {
    const seedPath = join(repoRoot, "scripts/seed-florida-interim-atoms.mjs");
    let exists = true;
    try {
      readFileSync(seedPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
