import { randomUUID } from "node:crypto";

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { db, qaRuns, type QaRunStatus } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { getSuiteById, type QaSuite } from "./suites";

/** Cap on log bytes persisted per run — head/tail kept, middle elided. */
const LOG_BYTE_CAP = 256_000;

interface ActiveRun {
  runId: string;
  suiteId: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: number;
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<(chunk: RunStreamEvent) => void>;
}

const active = new Map<string, ActiveRun>(); // runId → run
const activeBySuite = new Map<string, string>(); // suiteId → runId

export type RunStreamEvent =
  | { type: "log"; data: string }
  | {
      type: "done";
      status: QaRunStatus;
      exitCode: number | null;
      durationMs: number;
    };

export interface KickoffResult {
  runId: string;
  startedAt: Date;
}

export class SuiteAlreadyRunningError extends Error {
  constructor(public readonly runId: string) {
    super(`Suite already running (run id ${runId})`);
    this.name = "SuiteAlreadyRunningError";
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");

export async function startRun(suite: QaSuite): Promise<KickoffResult> {
  const existingRunId = activeBySuite.get(suite.id);
  if (existingRunId) {
    throw new SuiteAlreadyRunningError(existingRunId);
  }

  const runId = randomUUID();
  const startedAt = new Date();

  activeBySuite.set(suite.id, runId);

  let row: { id: string; startedAt: Date } | undefined;
  try {
    const inserted = await db
      .insert(qaRuns)
      .values({
        id: runId,
        suiteId: suite.id,
        status: "running",
        startedAt,
        log: "",
      })
      .returning({ id: qaRuns.id, startedAt: qaRuns.startedAt });
    row = inserted[0];
    if (!row) throw new Error("Failed to insert qa_runs row");
  } catch (err) {
    if (activeBySuite.get(suite.id) === runId) {
      activeBySuite.delete(suite.id);
    }
    throw err;
  }

  const child = spawn(suite.command, [...suite.args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const run: ActiveRun = {
    runId: row.id,
    suiteId: suite.id,
    child,
    startedAt: startedAt.getTime(),
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
  };
  active.set(row.id, run);

  const onChunk = (data: Buffer) => {
    const text = data.toString("utf8");
    appendToBuffer(run, text);
    for (const sub of run.subscribers) {
      try {
        sub({ type: "log", data: text });
      } catch (err) {
        logger.warn({ err, runId: run.runId }, "qa-runner: subscriber threw");
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("error", (err) => {
    logger.error(
      { err, suiteId: suite.id, runId: run.runId },
      "qa-runner: child process errored",
    );
    appendToBuffer(run, `\n[runner] spawn error: ${err.message}\n`);
    void finalize(run, "errored", null);
  });

  child.on("close", (code) => {
    const status: QaRunStatus = code === 0 ? "passed" : "failed";
    void finalize(run, status, code);
  });

  return { runId: row.id, startedAt };
}

function appendToBuffer(run: ActiveRun, text: string): void {
  run.buffer.push(text);
  run.bufferBytes += Buffer.byteLength(text);
}

function truncateLog(run: ActiveRun): string {
  const full = run.buffer.join("");
  if (Buffer.byteLength(full) <= LOG_BYTE_CAP) return full;
  const halfCap = Math.floor(LOG_BYTE_CAP / 2);
  const head = full.slice(0, halfCap);
  const tail = full.slice(full.length - halfCap);
  return `${head}\n\n[... log truncated to ${LOG_BYTE_CAP} bytes ...]\n\n${tail}`;
}

async function finalize(
  run: ActiveRun,
  status: QaRunStatus,
  exitCode: number | null,
): Promise<void> {
  if (!active.has(run.runId)) return; // already finalized
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - run.startedAt;
  const log = truncateLog(run);
  try {
    await db
      .update(qaRuns)
      .set({ status, finishedAt, exitCode, log })
      .where(eq(qaRuns.id, run.runId));
  } catch (err) {
    logger.error(
      { err, runId: run.runId },
      "qa-runner: failed to persist final run row",
    );
  }
  for (const sub of run.subscribers) {
    try {
      sub({ type: "done", status, exitCode, durationMs });
    } catch (err) {
      logger.warn({ err, runId: run.runId }, "qa-runner: done-subscriber threw");
    }
  }
  run.subscribers.clear();
  active.delete(run.runId);
  if (activeBySuite.get(run.suiteId) === run.runId) {
    activeBySuite.delete(run.suiteId);
  }
}

export interface SubscribeHandle {
  /** Initial buffered output that has accumulated before subscribe. */
  initial: string;
  unsubscribe(): void;
}

export function subscribeToRun(
  runId: string,
  onEvent: (e: RunStreamEvent) => void,
): SubscribeHandle | null {
  const run = active.get(runId);
  if (!run) return null;
  const initial = run.buffer.join("");
  run.subscribers.add(onEvent);
  return {
    initial,
    unsubscribe: () => {
      run.subscribers.delete(onEvent);
    },
  };
}

export function isRunActive(runId: string): boolean {
  return active.has(runId);
}

export function getActiveRunIdForSuite(suiteId: string): string | null {
  return activeBySuite.get(suiteId) ?? null;
}

/**
 * Resolve when the given run finishes (or immediately if it has already
 * finalized). Used by the autopilot orchestrator to drive sequential
 * runs over the suite registry without polling the runs table.
 */
export interface RunOutcome {
  status: QaRunStatus;
  exitCode: number | null;
  durationMs: number;
  log: string;
}

export async function waitForRun(runId: string): Promise<RunOutcome> {
  const live = active.get(runId);
  if (live) {
    return new Promise<RunOutcome>((resolve) => {
      const onEvent = (e: RunStreamEvent) => {
        if (e.type !== "done") return;
        live.subscribers.delete(onEvent);
        resolve({
          status: e.status,
          exitCode: e.exitCode,
          durationMs: e.durationMs,
          log: live.buffer.join(""),
        });
      };
      live.subscribers.add(onEvent);
    });
  }
  const [row] = await db
    .select()
    .from(qaRuns)
    .where(eq(qaRuns.id, runId))
    .limit(1);
  if (!row) {
    return { status: "errored", exitCode: null, durationMs: 0, log: "" };
  }
  return {
    status: row.status as QaRunStatus,
    exitCode: row.exitCode,
    durationMs: row.finishedAt
      ? row.finishedAt.getTime() - row.startedAt.getTime()
      : 0,
    log: row.log,
  };
}

/** Convenience: start a suite run and wait for it to finish. */
export async function runSuiteToCompletion(suite: QaSuite): Promise<{
  runId: string;
  outcome: RunOutcome;
}> {
  const { runId } = await startRun(suite);
  const outcome = await waitForRun(runId);
  return { runId, outcome };
}

/** Repo root, exported for callers (autopilot fixers) that need to spawn
 *  workspace-relative commands. */
export const QA_REPO_ROOT = REPO_ROOT;

export interface StartAllResult {
  started: Array<{ suiteId: string; runId: string }>;
  skipped: Array<{ suiteId: string; reason: string }>;
}

export async function startAllSuites(
  suites: ReadonlyArray<QaSuite>,
): Promise<StartAllResult> {
  const started: StartAllResult["started"] = [];
  const skipped: StartAllResult["skipped"] = [];
  for (const suite of suites) {
    const known = getSuiteById(suite.id);
    if (!known) {
      skipped.push({ suiteId: suite.id, reason: "unknown suite" });
      continue;
    }
    try {
      const r = await startRun(known);
      started.push({ suiteId: suite.id, runId: r.runId });
    } catch (err) {
      if (err instanceof SuiteAlreadyRunningError) {
        skipped.push({ suiteId: suite.id, reason: "already running" });
      } else {
        skipped.push({
          suiteId: suite.id,
          reason: err instanceof Error ? err.message : "unknown error",
        });
      }
    }
  }
  return { started, skipped };
}
