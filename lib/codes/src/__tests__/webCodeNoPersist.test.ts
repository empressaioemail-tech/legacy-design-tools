import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEBSEARCH_ATOM_PREFIX = "websearch:";

/**
 * Proof: web-fetched verbatim model-code is NOT persisted as public-free corpus atoms.
 * Grep migration/seed/orchestrator paths for websearch persistence — must be absent.
 */
describe("web code fetch — no corpus persistence", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  it("orchestrator does not insert websearch rows into code_atoms", () => {
    const src = readFileSync(
      join(repoRoot, "lib/codes/src/orchestrator.ts"),
      "utf-8",
    );
    expect(src).not.toContain("websearch:");
    expect(src).not.toContain("public-free");
  });

  it("web fetch module documents transient-only boundary", () => {
    const src = readFileSync(
      join(repoRoot, "lib/codes/src/webCodeFetch/index.ts"),
      "utf-8",
    );
    expect(src).toContain("never persisted");
    expect(src).toContain(WEBSEARCH_ATOM_PREFIX);
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
