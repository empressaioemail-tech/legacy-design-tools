/**
 * Pre-merge guard against workspace dependency cycles — Task #394.
 *
 * Why this exists
 * ---------------
 * Task #373 quietly closed a `@workspace/portal-ui` ↔
 * `@workspace/briefing-prior-snapshot` cycle. `pnpm install` printed
 * a `WARN  There are cyclic workspace dependencies …` line but
 * nothing in CI failed on it; Task #388 untangled it only because a
 * human happened to spot the warning in install output. This suite
 * is the missing alarm: it builds the same workspace graph
 * `pnpm install` walks (every `workspace:*` edge across all four
 * dependency buckets) and fails the build if any cycle exists.
 *
 * The two cases below cover the two failure modes we care about:
 *
 *   1. *Today's repo is acyclic* — runs `findWorkspaceCycles`
 *      against the real workspace and asserts the cycle list is
 *      empty. This is the gate that fires when someone reintroduces
 *      a real lib-to-lib loop on a PR.
 *
 *   2. *The detector itself catches the regression case* — feeds an
 *      in-memory fixture that re-creates the Task #373 edge
 *      (portal-ui → briefing-prior-snapshot, while
 *      briefing-prior-snapshot → portal-ui still exists) and asserts
 *      both nodes appear in the reported cycle. Without this, a
 *      future refactor could neutralise the SCC walker (e.g. by
 *      filtering out devDependencies) and the live check above
 *      would still pass on a clean tree.
 */

import { describe, it, expect } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findCycles,
  findRepoRoot,
  findWorkspaceCycles,
  formatCycle,
  loadWorkspacePackages,
  parseWorkspaceGlobs,
  type WorkspacePackage,
} from "../checkWorkspaceCycles";

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

describe("workspace dependency cycles — Task #394", () => {
  it("the live workspace has no cycles", () => {
    const { packages, cycles } = findWorkspaceCycles({ root: repoRoot });

    // Sanity check — if discovery breaks (e.g. the workspace globs
    // change shape and our minimal parser stops matching them) the
    // graph would be empty and the cycle assertion below would
    // trivially pass. Pin a small floor on the package count so a
    // silently-empty graph fails this test instead.
    expect(packages.size).toBeGreaterThanOrEqual(10);
    expect(packages.has("@workspace/portal-ui")).toBe(true);

    if (cycles.length > 0) {
      // Hand-formatted message so the failing CI log immediately
      // shows the offending edges instead of a JSON blob.
      const rendered = cycles.map((c, i) => `  ${i + 1}. ${formatCycle(c)}`).join("\n");
      throw new Error(
        `Found ${cycles.length} workspace dependency cycle(s):\n${rendered}\n` +
          `Drop one of the workspace edges above to break the loop.`,
      );
    }
  });

  it("loadWorkspacePackages discovers every lib package on disk", () => {
    // This is the bridge between the real-workspace test above and
    // the fixture-driven detector test below: it pins that the
    // discovery layer (yaml glob parse + package.json scan) really
    // does cover lib/ — if it stopped, the live cycle check would
    // become a no-op without anyone noticing.
    const packages = loadWorkspacePackages(repoRoot);
    const libNames = [
      "@workspace/portal-ui",
      "@workspace/briefing-prior-snapshot",
      "@workspace/briefing-diff",
      "@workspace/db",
      "@workspace/api-zod",
    ];
    for (const name of libNames) {
      expect(packages.get(name)?.name).toBe(name);
    }
  });

  it("detects the Task #373 portal-ui ↔ briefing-prior-snapshot regression", () => {
    // Re-create the exact edge Task #388 removed, against a hand-
    // built graph so the test is independent of the live tree. If
    // someone reintroduces this edge in lib/portal-ui/package.json,
    // the live test above will fire; if someone weakens the detector
    // (e.g. stops following devDependencies, or filters by edge
    // type), this test fires.
    const fixture = makeGraph({
      "@workspace/portal-ui": ["@workspace/briefing-prior-snapshot"],
      "@workspace/briefing-prior-snapshot": ["@workspace/portal-ui"],
      // A third, unrelated package proves the SCC walker doesn't
      // sweep up neighbours of the cycle that are themselves acyclic.
      "@workspace/api-zod": [],
    });

    const cycles = findCycles(fixture);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toEqual(
      expect.arrayContaining([
        "@workspace/briefing-prior-snapshot",
        "@workspace/portal-ui",
      ]),
    );
    expect(cycles[0].nodes).toHaveLength(2);
  });

  it("detects longer cycles (a → b → c → a) and ignores acyclic neighbours", () => {
    // Tarjan-on-a-triangle is the next thing to break if someone
    // swaps the SCC pass for a simpler 'check direct back-edge' test
    // — that shortcut would miss any cycle of length ≥ 3, which is
    // exactly the shape a real four-package refactor would produce.
    const fixture = makeGraph({
      "@workspace/a": ["@workspace/b"],
      "@workspace/b": ["@workspace/c"],
      "@workspace/c": ["@workspace/a"],
      "@workspace/d": ["@workspace/a"], // depends on the cycle but isn't in it
    });

    const cycles = findCycles(fixture);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toHaveLength(3);
    expect([...cycles[0].nodes].sort()).toEqual([
      "@workspace/a",
      "@workspace/b",
      "@workspace/c",
    ]);
  });

  it("flags a self-loop (a package that depends on itself)", () => {
    // Tarjan emits self-loops as size-1 SCCs; the detector has to
    // explicitly inspect for the self-edge or it'll silently drop
    // them. This test is the canary for that branch.
    const fixture = makeGraph({
      "@workspace/loner": ["@workspace/loner"],
      "@workspace/other": [],
    });

    const cycles = findCycles(fixture);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toEqual(["@workspace/loner"]);
  });

  it("returns an empty cycle list for a fully acyclic graph", () => {
    const fixture = makeGraph({
      "@workspace/leaf": [],
      "@workspace/mid": ["@workspace/leaf"],
      "@workspace/root": ["@workspace/mid", "@workspace/leaf"],
    });
    expect(findCycles(fixture)).toEqual([]);
  });

  it("parseWorkspaceGlobs handles the real pnpm-workspace.yaml shape", () => {
    // Guards the home-grown YAML reader against the two trip wires
    // we actually hit in this repo: a plain glob, and a quoted
    // glob. A more permissive YAML lib would cover more cases but
    // would also pull a runtime dep into a script that has to run
    // on a clean checkout.
    const yaml = [
      "packages:",
      "  - artifacts/*",
      "  - 'lib/*'",
      "  - lib/integrations/*",
      "  - scripts",
      "",
      "autoInstallPeers: false",
      "catalog:",
      "  react: 19.1.0",
    ].join("\n");
    expect(parseWorkspaceGlobs(yaml)).toEqual([
      "artifacts/*",
      "lib/*",
      "lib/integrations/*",
      "scripts",
    ]);
  });
});

/**
 * Build a fixture graph from a `{ name: [deps] }` shorthand. The dir
 * field is unused by the cycle finder but we still set it to keep
 * the `WorkspacePackage` type happy and make any future graph-level
 * assertions (e.g. printing a path) work.
 */
function makeGraph(
  edges: Record<string, readonly string[]>,
): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const [name, deps] of Object.entries(edges)) {
    out.set(name, {
      name,
      dir: `fixture/${name.replace(/^@workspace\//, "")}`,
      workspaceDeps: new Set(deps),
    });
  }
  return out;
}
