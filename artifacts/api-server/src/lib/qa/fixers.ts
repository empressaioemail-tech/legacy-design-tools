/**
 * Task #482 — QA autopilot safe-fixer allow-list.
 *
 * Each fixer in this file is one explicit recipe the dashboard is
 * allowed to apply without human approval. The contract:
 *
 *   - `id`        — stable identifier persisted on `autopilot_fix_actions`.
 *   - `appliesTo` — predicate on the bundle of findings for one suite.
 *                   A fixer only runs when its predicate returns true.
 *   - `apply`     — runs the fix in the workspace cwd, returns the list
 *                   of files it touched plus stdout/stderr. Must NEVER
 *                   modify product source files (assert in tests).
 *
 * Anything outside this allow-list is left untouched and the related
 * findings are tagged `needs-review` by the orchestrator.
 *
 * Note on snapshot updates: we deliberately constrain the snapshot
 * fixer to runs whose ONLY failures are snapshot-category. After
 * running `vitest -u` the orchestrator re-runs the suite — if it
 * comes back green, we keep the change; if not, we revert via `git
 * checkout` before reporting `needs-review`.
 */

import { spawn } from "node:child_process";
import { QA_REPO_ROOT } from "./runner";
import type { ClassifiedFinding } from "./classifier";
import type { QaSuite } from "./suites";

export interface FixerOutcome {
  filesChanged: string[];
  command: string;
  log: string;
  success: boolean;
}

export interface SafeFixer {
  readonly id: string;
  readonly description: string;
  appliesTo(suite: QaSuite, findings: ReadonlyArray<ClassifiedFinding>): boolean;
  apply(suite: QaSuite): Promise<FixerOutcome>;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function spawnCmd(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd ?? QA_REPO_ROOT,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, opts.timeoutMs);
    }
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` });
    });
  });
}

/**
 * `git status --porcelain` parser — returns the relative paths of
 * files modified, added, or untracked since the last commit. Used to
 * verify which files a fixer actually changed (so we can revert just
 * those if the post-fix re-run still fails).
 */
async function gitChangedFiles(): Promise<string[]> {
  const r = await spawnCmd("git", ["status", "--porcelain"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[A-Z?! ]{1,3}/, "").trim())
    .filter(Boolean);
}

export async function gitRevertPaths(paths: ReadonlyArray<string>): Promise<void> {
  if (paths.length === 0) return;
  // Restore tracked files; remove untracked files that the fixer added.
  await spawnCmd("git", ["checkout", "--", ...paths]);
  await spawnCmd("git", ["clean", "-fd", "--", ...paths]);
}

// ---------------------------------------------------------------------------
// Fixer: codegen regen
// ---------------------------------------------------------------------------

const codegenRegen: SafeFixer = {
  id: "codegen-regen",
  description: "Re-run @workspace/api-spec codegen to refresh generated clients",
  appliesTo: (_suite, findings) => findings.some((f) => f.category === "codegen-stale"),
  apply: async () => {
    const args = ["--filter", "@workspace/api-spec", "run", "codegen"];
    const cmd = `pnpm ${args.join(" ")}`;
    const before = await gitChangedFiles();
    const r = await spawnCmd("pnpm", args, { timeoutMs: 120_000 });
    const after = await gitChangedFiles();
    const changed = after.filter((f) => !before.includes(f));
    return {
      filesChanged: changed,
      command: cmd,
      log: r.stdout + r.stderr,
      success: r.exitCode === 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Fixer: prettier --write (formatting only — never modifies semantics)
// ---------------------------------------------------------------------------

const prettierFormat: SafeFixer = {
  id: "prettier-format",
  description: "Run prettier --write across the workspace to fix formatting drift",
  appliesTo: (_suite, findings) => findings.some((f) => f.category === "lint"),
  apply: async () => {
    const args = ["exec", "prettier", "--write", "."];
    const cmd = `pnpm ${args.join(" ")}`;
    const before = await gitChangedFiles();
    const r = await spawnCmd("pnpm", args, { timeoutMs: 120_000 });
    const after = await gitChangedFiles();
    const changed = after.filter((f) => !before.includes(f));
    return {
      filesChanged: changed,
      command: cmd,
      log: r.stdout + r.stderr,
      success: r.exitCode === 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Fixer: snapshot update (vitest -u). ONLY runs when every failure on
// the suite is snapshot-category — otherwise we'd be silently masking
// a real regression behind an updated snapshot.
// ---------------------------------------------------------------------------

const snapshotUpdate: SafeFixer = {
  id: "snapshot-update",
  description: "Run vitest -u to refresh snapshots when only snapshot diffs failed",
  appliesTo: (suite, findings) =>
    suite.kind === "vitest" &&
    findings.length > 0 &&
    findings.every((f) => f.category === "snapshot"),
  apply: async (suite) => {
    const args = [...suite.args, "--", "-u"];
    const cmd = `${suite.command} ${args.join(" ")}`;
    const before = await gitChangedFiles();
    const r = await spawnCmd(suite.command, args, { timeoutMs: 180_000 });
    const after = await gitChangedFiles();
    const changed = after.filter((f) => !before.includes(f));
    // Belt-and-suspenders: if vitest -u touched anything outside a
    // `__snapshots__` dir, revert and report failure. Snapshots only
    // live in `**/__snapshots__/**` by convention.
    const outsideSnapshots = changed.filter(
      (f) => !f.includes("__snapshots__/"),
    );
    if (outsideSnapshots.length > 0) {
      await gitRevertPaths(outsideSnapshots);
      return {
        filesChanged: changed.filter((f) => f.includes("__snapshots__/")),
        command: cmd,
        log: r.stdout + r.stderr +
          `\n[autopilot] reverted non-snapshot edits: ${outsideSnapshots.join(", ")}\n`,
        success: false,
      };
    }
    return {
      filesChanged: changed,
      command: cmd,
      log: r.stdout + r.stderr,
      success: r.exitCode === 0,
    };
  },
};

export const SAFE_FIXERS: ReadonlyArray<SafeFixer> = [
  codegenRegen,
  prettierFormat,
  snapshotUpdate,
];

export function pickFixers(
  suite: QaSuite,
  findings: ReadonlyArray<ClassifiedFinding>,
): SafeFixer[] {
  return SAFE_FIXERS.filter((f) => f.appliesTo(suite, findings));
}
