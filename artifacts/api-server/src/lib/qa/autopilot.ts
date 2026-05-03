/**
 * Task #482 — QA Dashboard Autopilot orchestrator.
 *
 * Drives the suite registry end-to-end on a single trigger
 * (manual button or "auto-on-open"), captures structured findings,
 * applies allow-listed safe fixers, and persists everything to
 * `autopilot_runs` / `autopilot_findings` / `autopilot_fix_actions`.
 *
 * Concurrency model:
 *   - Only one autopilot run can be in flight at a time. A second
 *     `start` call while one is active returns the active run id
 *     instead of stacking.
 *   - Suites are run sequentially. Playwright suites in particular
 *     spin up dev servers and a browser; running them in parallel
 *     would race over `localhost:80` proxy routing and saturate the
 *     test container.
 *
 * Safe-fix loop:
 *   - For each failing suite, classify findings, then ask each
 *     allow-listed fixer in `pickFixers(...)` whether it applies.
 *     Each fixer that applies runs in isolation and gets a fresh
 *     re-run of the suite to verify green. If the re-run passes,
 *     the matching findings are tagged `auto-fixed`. If not, the
 *     fixer's edits are reverted and the findings remain
 *     `needs-review`.
 *   - Findings whose category isn't in any fixer's predicate are
 *     left as `needs-review`.
 *
 * The flake-retry path is special-cased: a suite that fails on its
 * first run and passes on a single automatic retry is recorded as a
 * `flaky` run (no findings reported as broken), per the task's
 * "flake handling" requirement.
 */

import { db } from "@workspace/db";
import {
  autopilotRuns,
  autopilotFindings,
  autopilotFixActions,
  type AutopilotRun,
  type AutopilotFinding,
  type AutopilotFixAction,
  type AutopilotTrigger,
  type AutopilotFindingAutoFixStatus,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../logger";
import { QA_SUITES, type QaSuite } from "./suites";
import { runSuiteToCompletion, type RunOutcome } from "./runner";
import { classifyRunLog, type ClassifiedFinding } from "./classifier";
import { pickFixers, gitRevertPaths } from "./fixers";
import { suggestDiffForFinding } from "./diffSuggester";
import { getAutopilotNotifySettings } from "./settings";

/**
 * Max wall-clock budget for a single autopilot run. If the orchestrator
 * has not completed within this window the run is forcibly flipped to
 * `errored` so it can't block new runs indefinitely.
 */
export const AUTOPILOT_MAX_RUNTIME_MS = 30 * 60 * 1000;

let autopilotMaxRuntimeMsOverride: number | null = null;
/** Test hook: shrink the watchdog budget without faking timers. */
export function _setAutopilotMaxRuntimeMsForTesting(ms: number | null): void {
  autopilotMaxRuntimeMsOverride = ms;
}

/**
 * Cluster-wide advisory-lock key for `startAutopilotRun`. Hash of
 * the literal "qa.autopilot.start" so the value is stable across
 * processes / restarts.
 */
const AUTOPILOT_START_LOCK_KEY = 7732_419_835_201_111n;

export class AutopilotAlreadyRunningError extends Error {
  constructor(public readonly runId: string) {
    super(`Autopilot already running (run id ${runId})`);
    this.name = "AutopilotAlreadyRunningError";
  }
}

export interface StartAutopilotResult {
  runId: string;
  startedAt: Date;
}

/**
 * Returns the id of the currently in-flight autopilot run, if any.
 *
 * The `autopilot_runs` table is the sole source of truth — there is no
 * in-memory cache, so a server restart can never desync the read.
 */
export async function getActiveAutopilotRunId(): Promise<string | null> {
  const [row] = await db
    .select({ id: autopilotRuns.id })
    .from(autopilotRuns)
    .where(eq(autopilotRuns.status, "running"))
    .orderBy(desc(autopilotRuns.startedAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Predicate used by the orchestration loop after every awaited
 * suite/fixer step: if the run has been flipped out of `running` by
 * the watchdog or the boot reconciler, the loop must bail before
 * running more side-effecting work.
 */
async function isAutopilotRunStillRunning(
  autopilotRunId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ status: autopilotRuns.status })
    .from(autopilotRuns)
    .where(eq(autopilotRuns.id, autopilotRunId))
    .limit(1);
  return row?.status === "running";
}

/**
 * Flip every `autopilot_runs` row left in `status = 'running'` to
 * `errored` with a "[reconcile] abandoned by server restart" note.
 * Such rows are by definition orphaned — their background orchestration
 * died with the previous process. Also stamps `finishedAt` on any
 * `autopilot_fix_actions` rows tied to those runs that never finished.
 *
 * Returns the number of runs reconciled.
 */
export async function reconcileOrphanedAutopilotRuns(): Promise<number> {
  const orphans = await db
    .select({ id: autopilotRuns.id })
    .from(autopilotRuns)
    .where(eq(autopilotRuns.status, "running"));
  if (orphans.length === 0) return 0;
  const finishedAt = new Date();
  for (const o of orphans) {
    await db
      .update(autopilotRuns)
      .set({
        status: "errored",
        finishedAt,
        notes: sql`COALESCE(${autopilotRuns.notes}, '') || E'\n[reconcile] abandoned by server restart'`,
      })
      .where(
        and(eq(autopilotRuns.id, o.id), eq(autopilotRuns.status, "running")),
      );
    await db
      .update(autopilotFixActions)
      .set({ finishedAt })
      .where(
        and(
          eq(autopilotFixActions.autopilotRunId, o.id),
          isNull(autopilotFixActions.finishedAt),
        ),
      );
    logger.warn(
      { autopilotRunId: o.id },
      "autopilot: reconciled orphan run on boot (abandoned by server restart)",
    );
  }
  return orphans.length;
}

/**
 * Kick off a new autopilot run. Returns immediately after persisting
 * the row; suite execution + the fix loop runs in the background.
 *
 * Concurrency: the check-then-insert is wrapped in a transaction
 * guarded by a postgres advisory lock so two concurrent callers (or
 * two API processes behind a load balancer) cannot both observe an
 * empty `running` row and insert duplicates.
 */
export async function startAutopilotRun(
  trigger: AutopilotTrigger,
  suites: ReadonlyArray<QaSuite> = QA_SUITES,
): Promise<StartAutopilotResult> {
  const startedAt = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${AUTOPILOT_START_LOCK_KEY})`,
    );
    const [existing] = await tx
      .select({ id: autopilotRuns.id })
      .from(autopilotRuns)
      .where(eq(autopilotRuns.status, "running"))
      .orderBy(desc(autopilotRuns.startedAt))
      .limit(1);
    if (existing) {
      return { kind: "existing" as const, id: existing.id };
    }
    const [row] = await tx
      .insert(autopilotRuns)
      .values({
        status: "running",
        trigger,
        startedAt,
        totalSuites: suites.length,
      })
      .returning({ id: autopilotRuns.id, startedAt: autopilotRuns.startedAt });
    if (!row) throw new Error("Failed to insert autopilot_runs row");
    return { kind: "new" as const, id: row.id, startedAt: row.startedAt };
  });
  if (result.kind === "existing") {
    throw new AutopilotAlreadyRunningError(result.id);
  }
  // Fire-and-forget the actual orchestration; progress is surfaced via
  // the persisted row + findings, not via a returned promise.
  void executeAutopilotRun(result.id, suites).catch((err) => {
    logger.error({ err, autopilotRunId: result.id }, "autopilot: run threw");
  });
  return { runId: result.id, startedAt: result.startedAt };
}

interface SuiteResult {
  suite: QaSuite;
  qaRunId: string;
  outcome: RunOutcome;
  flaky: boolean;
  findings: ClassifiedFinding[];
}

async function executeAutopilotRun(
  autopilotRunId: string,
  suites: ReadonlyArray<QaSuite>,
): Promise<void> {
  let passing = 0;
  let failing = 0;
  let flakyCount = 0;
  let autoFixesApplied = 0;
  let needsReview = 0;
  const notes: string[] = [];

  // Per-run watchdog. If the orchestration loop hangs (e.g. a suite
  // child process never exits, or a fixer wedges on git state), this
  // timer flips the row to `errored`. The loop checks the row's status
  // after every awaited step (`isAutopilotRunStillRunning`) and bails
  // before doing further side effects, so once the watchdog fires no
  // additional findings/fixers/git mutations are issued.
  const watchdog = setTimeout(
    () => {
      void (async () => {
        try {
          await db
            .update(autopilotRuns)
            .set({
              status: "errored",
              finishedAt: new Date(),
              notes: sql`COALESCE(${autopilotRuns.notes}, '') || E'\n[watchdog] exceeded max runtime'`,
            })
            .where(
              and(
                eq(autopilotRuns.id, autopilotRunId),
                eq(autopilotRuns.status, "running"),
              ),
            );
          logger.error(
            { autopilotRunId },
            "autopilot: watchdog tripped — run exceeded max runtime",
          );
        } catch (err) {
          logger.error(
            { err, autopilotRunId },
            "autopilot: watchdog DB update failed",
          );
        }
      })();
    },
    autopilotMaxRuntimeMsOverride ?? AUTOPILOT_MAX_RUNTIME_MS,
  );
  // Don't keep the event loop alive just for the watchdog — the
  // orchestrator's own promise chain already does that.
  if (typeof watchdog.unref === "function") watchdog.unref();

  // Sentinel thrown when a checkpoint observes that the run is no
  // longer `running` (watchdog fired or boot reconciler ran). It
  // propagates to the outer `try/finally` and skips the final status
  // update entirely, leaving whatever terminal status the watchdog/
  // reconciler set in place.
  class AutopilotBailout extends Error {
    constructor() {
      super("autopilot: bail — run no longer in `running` status");
      this.name = "AutopilotBailout";
    }
  }
  const bailIfNotRunning = async (): Promise<void> => {
    if (!(await isAutopilotRunStillRunning(autopilotRunId))) {
      throw new AutopilotBailout();
    }
  };

  try {
    for (const suite of suites) {
      await bailIfNotRunning();
      const suiteResult = await runWithFlakeRetry(suite);
      await bailIfNotRunning();

      if (suiteResult.outcome.status === "passed" && !suiteResult.flaky) {
        passing += 1;
        continue;
      }
      if (suiteResult.flaky) {
        flakyCount += 1;
        notes.push(`${suite.id}: flaky — passed on retry`);
      }

      // Persist findings for this suite (all start as `needs-review`;
      // the fix loop below upgrades to `auto-fixed` where applicable).
      const persistedFindings = await persistFindings(
        autopilotRunId,
        suite,
        suiteResult.qaRunId,
        suiteResult.findings,
        suiteResult.flaky ? "skipped" : "needs-review",
      );

      if (suiteResult.flaky) {
        // Flake findings are informational only; don't trip the
        // failing/needs-review counter.
        continue;
      }

      // Try each safe fixer that matches this suite's findings.
      const fixers = pickFixers(suite, suiteResult.findings);
      let suiteFixed = false;
      for (const fixer of fixers) {
        await bailIfNotRunning();
        const action = await runFixer(
          autopilotRunId,
          suite,
          fixer.id,
          fixer.description,
          () => fixer.apply(suite),
          persistedFindings.map((f) => f.id),
        );
        if (!action.success) continue;

        await bailIfNotRunning();
        // Re-run the suite to confirm green.
        const verify = await runSuiteToCompletion(suite);
        await bailIfNotRunning();
        const verifyOk = verify.outcome.status === "passed";

        await db
          .update(autopilotFixActions)
          .set({
            log: action.log + `\n[verify] re-run status=${verify.outcome.status}\n`,
          })
          .where(eq(autopilotFixActions.id, action.id));

        if (verifyOk) {
          // Mark the matching findings as auto-fixed.
          for (const f of persistedFindings) {
            if (fixerCoversFinding(fixer.id, f)) {
              await db
                .update(autopilotFindings)
                .set({ autoFixStatus: "auto-fixed" })
                .where(eq(autopilotFindings.id, f.id));
              autoFixesApplied += 1;
            }
          }
          suiteFixed = true;
          break;
        } else {
          // Re-run still red — revert the fixer's edits and keep
          // the findings as needs-review so the human can take it
          // from here.
          const changedFiles = JSON.parse(action.filesChanged) as string[];
          await gitRevertPaths(changedFiles);
          await db
            .update(autopilotFixActions)
            .set({
              success: false,
              log: action.log + "\n[verify] reverted (re-run still failing)\n",
            })
            .where(eq(autopilotFixActions.id, action.id));
        }
      }

      if (suiteFixed) continue;

      failing += 1;
      needsReview += persistedFindings.length;

      // No safe fixer applied — for each remaining `needs-review`
      // finding, try to populate `suggestedDiff` so the dashboard can
      // surface a copy-paste patch hint. The suggester is proposal-
      // only; it never writes to the working tree.
      await populateSuggestedDiffs(persistedFindings, suiteResult.findings);
    }

    const finishedAt = new Date();
    // Scope to `status = 'running'` so a watchdog flip wins if it
    // already marked this row `errored`.
    await db
      .update(autopilotRuns)
      .set({
        status: "completed",
        finishedAt,
        passing,
        failing,
        flaky: flakyCount,
        autoFixesApplied,
        needsReview,
        notes: notes.join("\n"),
      })
      .where(
        and(
          eq(autopilotRuns.id, autopilotRunId),
          eq(autopilotRuns.status, "running"),
        ),
      );

    // Best-effort notification — never let a webhook failure mask a
    // successful run. Only fires when the sweep finished red and the
    // configured min severity threshold is met.
    try {
      await maybeNotifyRedSweep({
        autopilotRunId,
        startedAt: (await getRunStartedAt(autopilotRunId)) ?? finishedAt,
        finishedAt,
        passing,
        failing,
        flaky: flakyCount,
        autoFixesApplied,
        needsReview,
        totalSuites: suites.length,
      });
    } catch (err) {
      logger.warn(
        { err, autopilotRunId },
        "autopilot: notify webhook threw",
      );
    }
  } catch (err) {
    if (err instanceof AutopilotBailout) {
      logger.warn(
        { autopilotRunId },
        "autopilot: bailed mid-run (watchdog or reconciler flipped status)",
      );
    } else {
      logger.error({ err, autopilotRunId }, "autopilot: orchestration error");
      // Scope to `status = 'running'` so a watchdog flip wins.
      await db
        .update(autopilotRuns)
        .set({
          status: "errored",
          finishedAt: new Date(),
          notes:
            (notes.join("\n") + `\n[error] ${err instanceof Error ? err.message : String(err)}`).trim(),
        })
        .where(
          and(
            eq(autopilotRuns.id, autopilotRunId),
            eq(autopilotRuns.status, "running"),
          ),
        );
    }
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Run a suite once. If it fails, retry exactly once. If the retry
 * passes, mark as flaky and return the retry's outcome. Otherwise
 * return the second failure.
 */
async function runWithFlakeRetry(suite: QaSuite): Promise<SuiteResult> {
  const first = await runSuiteToCompletion(suite);
  const firstFindings = classifyRunLog({
    status: first.outcome.status === "passed" ? "passed" : first.outcome.status === "errored" ? "errored" : "failed",
    log: first.outcome.log,
  });

  if (first.outcome.status === "passed") {
    return {
      suite,
      qaRunId: first.runId,
      outcome: first.outcome,
      flaky: false,
      findings: [],
    };
  }
  // Single retry to detect flakes.
  const second = await runSuiteToCompletion(suite);
  if (second.outcome.status === "passed") {
    return {
      suite,
      qaRunId: second.runId,
      outcome: second.outcome,
      flaky: true,
      findings: firstFindings.map((f) => ({
        ...f,
        category: "flaky" as const,
        severity: "warning" as const,
        plainSummary: "Failed on first attempt, passed on retry",
      })),
    };
  }
  // Two failures — use the second run's classification (the freshest log).
  const secondFindings = classifyRunLog({
    status: second.outcome.status === "errored" ? "errored" : "failed",
    log: second.outcome.log,
  });
  return {
    suite,
    qaRunId: second.runId,
    outcome: second.outcome,
    flaky: false,
    findings: secondFindings,
  };
}

async function persistFindings(
  autopilotRunId: string,
  suite: QaSuite,
  qaRunId: string,
  findings: ReadonlyArray<ClassifiedFinding>,
  initialStatus: AutopilotFindingAutoFixStatus,
): Promise<AutopilotFinding[]> {
  if (findings.length === 0) return [];
  const rows = await db
    .insert(autopilotFindings)
    .values(
      findings.map((f) => ({
        autopilotRunId,
        suiteId: suite.id,
        qaRunId,
        testName: f.testName,
        filePath: f.filePath,
        line: f.line,
        errorExcerpt: f.errorExcerpt,
        category: f.category,
        severity: f.severity,
        autoFixStatus: initialStatus,
        plainSummary: f.plainSummary,
      })),
    )
    .returning();
  return rows;
}

async function runFixer(
  autopilotRunId: string,
  suite: QaSuite,
  fixerId: string,
  _description: string,
  apply: () => Promise<{
    filesChanged: string[];
    command: string;
    log: string;
    success: boolean;
  }>,
  findingIds: string[],
): Promise<AutopilotFixAction> {
  const startedAt = new Date();
  let outcome: {
    filesChanged: string[];
    command: string;
    log: string;
    success: boolean;
  };
  try {
    outcome = await apply();
  } catch (err) {
    outcome = {
      filesChanged: [],
      command: fixerId,
      log: `[fixer] threw: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    };
  }
  const [row] = await db
    .insert(autopilotFixActions)
    .values({
      autopilotRunId,
      findingId: findingIds[0] ?? null,
      fixerId,
      suiteId: suite.id,
      command: outcome.command,
      filesChanged: JSON.stringify(outcome.filesChanged),
      success: outcome.success,
      log: outcome.log.slice(-50_000),
      startedAt,
      finishedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("Failed to insert autopilot_fix_actions row");
  return row;
}

/**
 * For each persisted `app-code` (or `unknown`) finding still tagged
 * `needs-review`, call the diff suggester and write the result to
 * `autopilot_findings.suggestedDiff`. Skips findings whose category
 * is auto-fix-eligible (snapshot, codegen-stale, lint, fixture) or
 * which already have a suggested diff. The suggester never throws —
 * any error is logged and that finding is left blank.
 *
 * Empty/blank diffs are NOT persisted — we only write a value when
 * the suggester returns a real candidate patch.
 *
 * Safety: the suggester is read-only by contract. We only write the
 * resulting string to the DB; we never apply the patch to disk. The
 * `writeDiff` hook is exposed for tests so the orchestration logic
 * can be exercised without a real DB.
 */
export async function populateSuggestedDiffs(
  persisted: ReadonlyArray<AutopilotFinding>,
  classified: ReadonlyArray<ClassifiedFinding>,
  opts: { writeDiff?: (id: string, diff: string) => Promise<void> } = {},
): Promise<void> {
  const writeDiff =
    opts.writeDiff ??
    (async (id: string, diff: string) => {
      await db
        .update(autopilotFindings)
        .set({ suggestedDiff: diff })
        .where(eq(autopilotFindings.id, id));
    });
  for (let i = 0; i < persisted.length; i += 1) {
    const row = persisted[i];
    if (!row) continue;
    if (row.category !== "app-code" && row.category !== "unknown") continue;
    if (row.suggestedDiff && row.suggestedDiff.length > 0) continue;
    // The classified array is the same length and order as persisted
    // (see persistFindings), so we can pair by index.
    const source = classified[i] ?? {
      testName: row.testName,
      filePath: row.filePath,
      line: row.line,
      errorExcerpt: row.errorExcerpt,
      category: row.category,
      severity: row.severity,
      plainSummary: row.plainSummary,
    };
    try {
      const diff = await suggestDiffForFinding(source);
      if (!diff || diff.trim().length === 0) continue;
      await writeDiff(row.id, diff);
    } catch (err) {
      logger.warn(
        { err, findingId: row.id },
        "autopilot: suggestDiffForFinding threw — leaving suggestedDiff blank",
      );
    }
  }
}

/**
 * Coarse mapping from fixer id → finding category. Used to decide
 * which findings to mark `auto-fixed` after a successful fix-and-verify
 * loop. Mirrors the predicates in `fixers.ts`.
 */
function fixerCoversFinding(fixerId: string, f: AutopilotFinding): boolean {
  switch (fixerId) {
    case "snapshot-update":
      return f.category === "snapshot";
    case "codegen-regen":
      return f.category === "codegen-stale";
    case "prettier-format":
      return f.category === "lint";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Notifications (Task #484) — fire a webhook when a sweep finishes red.
// ---------------------------------------------------------------------------

interface NotifyContext {
  autopilotRunId: string;
  startedAt: Date;
  finishedAt: Date;
  passing: number;
  failing: number;
  flaky: number;
  autoFixesApplied: number;
  needsReview: number;
  totalSuites: number;
}

async function getRunStartedAt(autopilotRunId: string): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: autopilotRuns.startedAt })
    .from(autopilotRuns)
    .where(eq(autopilotRuns.id, autopilotRunId))
    .limit(1);
  return row?.startedAt ?? null;
}

async function maybeNotifyRedSweep(ctx: NotifyContext): Promise<void> {
  // Only notify when the sweep actually has red findings the team
  // needs to look at. flaky-only runs are noisy and skipped.
  if (ctx.failing === 0 && ctx.needsReview === 0) return;

  const settings = await getAutopilotNotifySettings();
  if (!settings.webhook) return;

  // minSeverity gating: today every persisted finding for a non-flaky
  // failing suite carries severity 'error', so 'warning' = always
  // notify when there are red findings, 'error' = same here. We still
  // check the failing-suite count so 'error' threshold won't fire on a
  // run with zero failing suites (e.g. only flaky retries surfaced).
  if (settings.minSeverity === "error" && ctx.failing === 0) return;

  const deepLink = buildDashboardDeepLink(ctx.autopilotRunId);
  const summary =
    `Autopilot sweep finished with ${ctx.failing} failing suite` +
    (ctx.failing === 1 ? "" : "s") +
    `, ${ctx.needsReview} finding` +
    (ctx.needsReview === 1 ? "" : "s") +
    " awaiting review.";

  const payload = {
    source: "qa-autopilot",
    runId: ctx.autopilotRunId,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: ctx.finishedAt.toISOString(),
    durationMs: ctx.finishedAt.getTime() - ctx.startedAt.getTime(),
    counts: {
      totalSuites: ctx.totalSuites,
      passing: ctx.passing,
      failing: ctx.failing,
      flaky: ctx.flaky,
      autoFixesApplied: ctx.autoFixesApplied,
      needsReview: ctx.needsReview,
    },
    summary,
    deepLink,
    // Slack-friendly fallback so the message is readable even if the
    // receiving webhook only renders `text`.
    text: `:rotating_light: ${summary}${deepLink ? `\n${deepLink}` : ""}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(settings.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn(
        { autopilotRunId: ctx.autopilotRunId, status: resp.status },
        "autopilot: notify webhook returned non-2xx",
      );
    } else {
      logger.info(
        { autopilotRunId: ctx.autopilotRunId },
        "autopilot: notification posted",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function buildDashboardDeepLink(autopilotRunId: string): string | null {
  const domains = process.env["REPLIT_DOMAINS"];
  if (!domains) return null;
  const host = domains.split(",")[0]?.trim();
  if (!host) return null;
  return `https://${host}/qa/autopilot?run=${encodeURIComponent(autopilotRunId)}`;
}

// ---------------------------------------------------------------------------
// Read-side helpers used by the route layer.
// ---------------------------------------------------------------------------

export async function getLatestAutopilotRun(): Promise<AutopilotRun | null> {
  const [row] = await db
    .select()
    .from(autopilotRuns)
    .orderBy(desc(autopilotRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export async function listAutopilotRuns(limit: number): Promise<AutopilotRun[]> {
  return db
    .select()
    .from(autopilotRuns)
    .orderBy(desc(autopilotRuns.startedAt))
    .limit(limit);
}

export async function getAutopilotRunDetail(runId: string): Promise<{
  run: AutopilotRun;
  findings: AutopilotFinding[];
  fixActions: AutopilotFixAction[];
} | null> {
  const [run] = await db
    .select()
    .from(autopilotRuns)
    .where(eq(autopilotRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const findings = await db
    .select()
    .from(autopilotFindings)
    .where(eq(autopilotFindings.autopilotRunId, runId));
  const fixActions = await db
    .select()
    .from(autopilotFixActions)
    .where(eq(autopilotFixActions.autopilotRunId, runId));
  return { run, findings, fixActions };
}
