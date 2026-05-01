/**
 * Workspace dependency-cycle detector — Task #394.
 *
 * Why this exists
 * ---------------
 * Task #388 untangled the `@workspace/portal-ui` ↔
 * `@workspace/briefing-prior-snapshot` cycle that Task #373
 * accidentally introduced. The cycle was benign at runtime (Vitest
 * still ran, types still resolved) but `pnpm install` printed a
 *
 *   WARN  There are cyclic workspace dependencies: …
 *
 * line that no automated check looked at. The next well-meaning
 * lib-to-lib edge that closes a loop would slip through the same gap.
 *
 * This module walks every `@workspace/*` package's declared workspace
 * dependencies (`dependencies`, `devDependencies`, `peerDependencies`,
 * `optionalDependencies`) and reports any cycles. Both the test
 * suite (`scripts/src/__tests__/workspaceCycles.test.ts`) and the
 * `check:cycles` npm script consume it; importing the module is
 * side-effect free thanks to the entrypoint guard at the bottom of
 * the file (same pattern as the other one-shot scripts in this
 * directory — see Task #336).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A workspace package as discovered from its `package.json`. */
export interface WorkspacePackage {
  /** The `name` field, e.g. `@workspace/portal-ui`. */
  readonly name: string;
  /** Repo-relative directory containing the `package.json`. */
  readonly dir: string;
  /** Names of other `@workspace/*` packages this one declares as a
   *  dependency in *any* dependency bucket. */
  readonly workspaceDeps: ReadonlySet<string>;
}

/**
 * One cycle in the workspace dependency graph. The list is rotated so
 * the lexicographically smallest member appears first, which makes
 * the test assertions deterministic regardless of the order Tarjan's
 * algorithm emits SCCs in.
 */
export interface WorkspaceCycle {
  readonly nodes: readonly string[];
}

/** Anything that exposes a `name` and dependency-bucket fields. */
type RawPackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const DEP_BUCKETS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly (keyof RawPackageJson)[];

/**
 * Parse the `packages:` list out of a `pnpm-workspace.yaml`. We avoid
 * pulling in a YAML dep because the only field we need is a flat
 * sequence of strings under a single top-level `packages:` key, and
 * that subset is trivial to read line-by-line. Anything fancier
 * (anchors, flow style, nested mappings) would already have failed
 * `pnpm install` before this script ran.
 */
export function parseWorkspaceGlobs(yamlSource: string): string[] {
  const lines = yamlSource.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of lines) {
    // Strip trailing comments. A `#` inside a quoted string would
    // confuse this, but workspace globs don't contain `#`.
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // A new top-level key (no leading whitespace, ends in `:`)
      // closes the `packages` block.
      if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
        inPackages = false;
        continue;
      }
      const match = /^\s*-\s*(['"]?)(.+?)\1\s*$/.exec(line);
      if (match) {
        globs.push(match[2]);
      }
    }
  }
  return globs;
}

/**
 * Expand a workspace glob (as accepted by pnpm-workspace.yaml) into
 * a list of repo-relative directories that contain a `package.json`.
 *
 * pnpm supports the full micromatch grammar but the patterns we use
 * in this repo are intentionally boring: a literal directory
 * (`scripts`) or a single `*` segment (`artifacts/*`,
 * `lib/integrations/*`). Implementing just that subset keeps this
 * script dependency-free; if anyone introduces a `**` glob in
 * pnpm-workspace.yaml they'll need to extend this matcher (and the
 * test below will fail loudly because the new package won't be
 * discovered).
 */
function expandGlob(root: string, glob: string): string[] {
  const segments = glob.split("/");
  let candidates: string[] = [""];
  for (const segment of segments) {
    const next: string[] = [];
    for (const cand of candidates) {
      const abs = join(root, cand);
      if (segment === "*") {
        let entries: string[];
        try {
          entries = readdirSync(abs);
        } catch {
          continue;
        }
        for (const entry of entries) {
          const entryAbs = join(abs, entry);
          let isDir = false;
          try {
            isDir = statSync(entryAbs).isDirectory();
          } catch {
            isDir = false;
          }
          if (isDir) next.push(cand === "" ? entry : `${cand}/${entry}`);
        }
      } else if (segment.includes("*")) {
        throw new Error(
          `Unsupported glob segment "${segment}" in workspace pattern "${glob}". ` +
            `Extend expandGlob() in checkWorkspaceCycles.ts to handle it.`,
        );
      } else {
        const entryAbs = join(abs, segment);
        let isDir = false;
        try {
          isDir = statSync(entryAbs).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) next.push(cand === "" ? segment : `${cand}/${segment}`);
      }
    }
    candidates = next;
  }
  // Only keep directories that actually have a package.json — pnpm
  // does the same and otherwise we'd report a half-empty graph.
  return candidates.filter((dir) => {
    try {
      return statSync(join(root, dir, "package.json")).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Discover every `@workspace/*` package under `root` based on the
 * `packages:` list in its `pnpm-workspace.yaml`. Returns a name-keyed
 * map for O(1) edge lookups during graph construction.
 */
export function loadWorkspacePackages(root: string): Map<string, WorkspacePackage> {
  const yamlPath = join(root, "pnpm-workspace.yaml");
  const globs = parseWorkspaceGlobs(readFileSync(yamlPath, "utf8"));
  const packages = new Map<string, WorkspacePackage>();
  for (const glob of globs) {
    for (const dir of expandGlob(root, glob)) {
      const pkgPath = join(root, dir, "package.json");
      const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as RawPackageJson;
      if (typeof raw.name !== "string") continue;
      const workspaceDeps = new Set<string>();
      for (const bucket of DEP_BUCKETS) {
        const entries = raw[bucket];
        if (!entries) continue;
        for (const [depName, depSpec] of Object.entries(entries)) {
          // Only edges that pnpm itself resolves to another workspace
          // package count toward a cycle. The `workspace:` protocol
          // is the unambiguous signal.
          if (typeof depSpec === "string" && depSpec.startsWith("workspace:")) {
            workspaceDeps.add(depName);
          }
        }
      }
      packages.set(raw.name, { name: raw.name, dir, workspaceDeps });
    }
  }
  return packages;
}

/**
 * Find every cycle in a workspace graph using Tarjan's strongly-
 * connected-components algorithm.
 *
 * Tarjan groups the graph into SCCs in a single DFS pass. An SCC
 * with two or more nodes *is* a cycle (every node in it can reach
 * every other). A singleton SCC is a cycle only if the node has a
 * self-edge — we check that explicitly because Tarjan emits self-
 * loops as size-1 SCCs and we don't want to silently miss a package
 * declaring itself as a workspace dep.
 *
 * Edges to names that aren't in `packages` are ignored (they'd be
 * non-workspace deps that slipped through the `workspace:` filter,
 * which shouldn't happen, but defensive code beats a crash on a
 * malformed manifest).
 */
export function findCycles(
  packages: ReadonlyMap<string, WorkspacePackage>,
): WorkspaceCycle[] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: WorkspaceCycle[] = [];
  let nextIndex = 0;

  const successors = (node: string): string[] => {
    const pkg = packages.get(node);
    if (!pkg) return [];
    const out: string[] = [];
    for (const dep of pkg.workspaceDeps) {
      if (packages.has(dep)) out.push(dep);
    }
    return out;
  };

  const strongconnect = (start: string): void => {
    // Iterative Tarjan — recursion would blow the stack on very deep
    // workspace trees and is awkward to follow when interleaved with
    // SCC bookkeeping. Each frame remembers where in the successor
    // list it left off so we can resume after a child returns.
    type Frame = { node: string; succ: string[]; i: number };
    const work: Frame[] = [];

    const push = (node: string): void => {
      indices.set(node, nextIndex);
      lowlinks.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, succ: successors(node), i: 0 });
    };

    push(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.i < frame.succ.length) {
        const next = frame.succ[frame.i];
        frame.i += 1;
        if (!indices.has(next)) {
          push(next);
        } else if (onStack.has(next)) {
          lowlinks.set(
            frame.node,
            Math.min(lowlinks.get(frame.node)!, indices.get(next)!),
          );
        }
        continue;
      }
      // All successors processed — finalise this node.
      work.pop();
      if (lowlinks.get(frame.node) === indices.get(frame.node)) {
        // Pop the SCC off the stack.
        const component: string[] = [];
        while (true) {
          const w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          component.push(w);
          if (w === frame.node) break;
        }
        const isMultiNodeCycle = component.length > 1;
        const isSelfLoop =
          component.length === 1 &&
          (packages.get(component[0])?.workspaceDeps.has(component[0]) ?? false);
        if (isMultiNodeCycle || isSelfLoop) {
          // Rotate so the lexicographically smallest name leads —
          // gives us deterministic output for snapshot-style asserts
          // and for human review.
          const sorted = [...component].sort();
          const lead = sorted[0];
          const leadIdx = component.indexOf(lead);
          const rotated = [
            ...component.slice(leadIdx),
            ...component.slice(0, leadIdx),
          ];
          cycles.push({ nodes: rotated });
        }
      }
      // Propagate lowlink to the parent frame.
      if (work.length > 0) {
        const parent = work[work.length - 1];
        lowlinks.set(
          parent.node,
          Math.min(lowlinks.get(parent.node)!, lowlinks.get(frame.node)!),
        );
      }
    }
  };

  // Walk in name order so any debug output is stable across runs.
  const nodes = [...packages.keys()].sort();
  for (const node of nodes) {
    if (!indices.has(node)) strongconnect(node);
  }

  // Sort cycles deterministically: by leading name, then size.
  cycles.sort((a, b) => {
    if (a.nodes[0] < b.nodes[0]) return -1;
    if (a.nodes[0] > b.nodes[0]) return 1;
    return a.nodes.length - b.nodes.length;
  });
  return cycles;
}

/**
 * Top-level helper used by both the CLI entrypoint and the test
 * suite. Returns the raw cycle list so callers can format it however
 * they like (the CLI prints; the test asserts).
 */
export function findWorkspaceCycles(options: { root: string }): {
  packages: Map<string, WorkspacePackage>;
  cycles: WorkspaceCycle[];
} {
  const packages = loadWorkspacePackages(options.root);
  const cycles = findCycles(packages);
  return { packages, cycles };
}

/** Render a cycle as `a → b → a` for human-readable error output. */
export function formatCycle(cycle: WorkspaceCycle): string {
  return [...cycle.nodes, cycle.nodes[0]].join(" → ");
}

/** Locate the repo root by walking up from a starting directory
 *  until a `pnpm-workspace.yaml` appears. Centralised here so the
 *  CLI and the tests agree on what counts as "the workspace". */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    try {
      if (statSync(join(dir, "pnpm-workspace.yaml")).isFile()) return dir;
    } catch {
      // fall through
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find pnpm-workspace.yaml above ${start}; ` +
          `is the script being run inside the monorepo?`,
      );
    }
    dir = parent;
  }
}

/**
 * CLI entrypoint. Prints either a green-field summary or a numbered
 * list of cycles, then exits 0/1 accordingly. Kept tiny so the
 * importable API above is what the tests actually exercise.
 */
export async function main(): Promise<void> {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const { packages, cycles } = findWorkspaceCycles({ root });
  if (cycles.length === 0) {
    console.log(
      `No workspace dependency cycles across ${packages.size} @workspace/* packages.`,
    );
    return;
  }
  console.error(
    `Detected ${cycles.length} workspace dependency cycle(s) ` +
      `among ${packages.size} @workspace/* packages:`,
  );
  for (const [i, cycle] of cycles.entries()) {
    console.error(`  ${i + 1}. ${formatCycle(cycle)}`);
    for (const name of cycle.nodes) {
      const pkg = packages.get(name);
      if (pkg) console.error(`       - ${name}  (${relative(root, pkg.dir) || pkg.dir})`);
    }
  }
  console.error(
    "\nFix by removing one of the workspace edges above. See Task #394.",
  );
  process.exit(1);
}

/**
 * Entrypoint guard — same shape as the other one-shot scripts in
 * this directory (`sweepOrphanAvatars.ts`, etc.; see Task #336).
 * Importing this module from a Vitest worker must never invoke
 * `main()` as a side effect, otherwise a missing-cycle assertion
 * would tear the worker down via `process.exit(1)` instead of
 * surfacing as a test failure.
 */
const invokedAsEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
