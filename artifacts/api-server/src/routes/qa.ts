import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db, qaRuns, qaChecklistResults } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../lib/logger";
import { QA_SUITES, getSuiteById } from "../lib/qa/suites";
import {
  QA_CHECKLISTS,
  getChecklistById,
  type QaChecklistItem,
} from "../lib/qa/checklists";
import {
  startRun,
  startAllSuites,
  subscribeToRun,
  getActiveRunIdForSuite,
  isRunActive,
  SuiteAlreadyRunningError,
  type RunStreamEvent,
} from "../lib/qa/runner";
import {
  startAutopilotRun,
  getActiveAutopilotRunId,
  getLatestAutopilotRun,
  listAutopilotRuns,
  getAutopilotRunDetail,
  AutopilotAlreadyRunningError,
} from "../lib/qa/autopilot";
import {
  isAutopilotEnabled,
  setSetting,
} from "../lib/qa/settings";

const router: IRouter = Router();

// -----------------------------------------------------------------------------
// Suites
// -----------------------------------------------------------------------------

router.get("/qa/suites", async (_req: Request, res: Response) => {
  // Pull the most recent run row per suite so the FE can render
  // last-status / last-time chips without a per-card N+1.
  const suiteSummaries = await Promise.all(
    QA_SUITES.map(async (suite) => {
      const [latest] = await db
        .select()
        .from(qaRuns)
        .where(eq(qaRuns.suiteId, suite.id))
        .orderBy(desc(qaRuns.startedAt))
        .limit(1);
      const activeRunId = getActiveRunIdForSuite(suite.id);
      return {
        id: suite.id,
        app: suite.app,
        kind: suite.kind,
        label: suite.label,
        description: suite.description,
        activeRunId,
        lastRun: latest
          ? {
              id: latest.id,
              status: latest.status,
              startedAt: latest.startedAt.toISOString(),
              finishedAt: latest.finishedAt
                ? latest.finishedAt.toISOString()
                : null,
              exitCode: latest.exitCode,
              durationMs:
                latest.finishedAt
                  ? latest.finishedAt.getTime() - latest.startedAt.getTime()
                  : null,
            }
          : null,
      };
    }),
  );
  res.json({ suites: suiteSummaries });
});

// -----------------------------------------------------------------------------
// Runs
// -----------------------------------------------------------------------------

const StartRunBody = z.object({
  suiteId: z.string().min(1),
});

router.post("/qa/runs", async (req: Request, res: Response) => {
  const parsed = StartRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const suite = getSuiteById(parsed.data.suiteId);
  if (!suite) {
    res.status(404).json({ error: "unknown_suite" });
    return;
  }
  try {
    const result = await startRun(suite);
    res
      .status(201)
      .json({ runId: result.runId, suiteId: suite.id, startedAt: result.startedAt.toISOString() });
  } catch (err) {
    if (err instanceof SuiteAlreadyRunningError) {
      res.status(409).json({ error: "already_running", runId: err.runId });
      return;
    }
    logger.error({ err, suiteId: suite.id }, "qa: failed to start run");
    res.status(500).json({ error: "start_failed" });
  }
});

router.post("/qa/runs/all", async (_req: Request, res: Response) => {
  try {
    const result = await startAllSuites(QA_SUITES);
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, "qa: failed to start all suites");
    res.status(500).json({ error: "start_all_failed" });
  }
});

router.get("/qa/runs", async (req: Request, res: Response) => {
  const suiteId =
    typeof req.query["suiteId"] === "string" ? req.query["suiteId"] : null;
  const limit = Math.min(
    Number(req.query["limit"] ?? 25) || 25,
    100,
  );
  const rows = await db
    .select()
    .from(qaRuns)
    .where(suiteId ? eq(qaRuns.suiteId, suiteId) : undefined)
    .orderBy(desc(qaRuns.startedAt))
    .limit(limit);
  res.json({
    runs: rows.map((r) => ({
      id: r.id,
      suiteId: r.suiteId,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      exitCode: r.exitCode,
      durationMs: r.finishedAt
        ? r.finishedAt.getTime() - r.startedAt.getTime()
        : null,
    })),
  });
});

router.get("/qa/runs/:runId", async (req: Request, res: Response) => {
  const runId = String(req.params.runId ?? "").trim();
  const [row] = await db.select().from(qaRuns).where(eq(qaRuns.id, runId)).limit(1);
  if (!row) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }
  res.json({
    id: row.id,
    suiteId: row.suiteId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    exitCode: row.exitCode,
    durationMs: row.finishedAt
      ? row.finishedAt.getTime() - row.startedAt.getTime()
      : null,
    log: row.log,
    isActive: isRunActive(row.id),
  });
});

router.get("/qa/runs/:runId/stream", async (req: Request, res: Response) => {
  const runId = String(req.params.runId ?? "").trim();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const writeFrame = (event: RunStreamEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const handle = subscribeToRun(runId, writeFrame);
  if (!handle) {
    // Run is not active — return whatever we persisted as a one-shot
    // replay so the FE doesn't have to special-case "not active".
    const [row] = await db
      .select()
      .from(qaRuns)
      .where(eq(qaRuns.id, runId))
      .limit(1);
    if (!row) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "run_not_found" })}\n\n`);
      res.end();
      return;
    }
    if (row.log) writeFrame({ type: "log", data: row.log });
    writeFrame({
      type: "done",
      status: row.status as RunStreamEvent extends { status: infer S } ? S : never,
      exitCode: row.exitCode,
      durationMs: row.finishedAt
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : 0,
    });
    res.end();
    return;
  }

  // Replay buffered output to the new subscriber so reconnects don't
  // miss the head of the log.
  if (handle.initial) writeFrame({ type: "log", data: handle.initial });

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    handle.unsubscribe();
  });
});

// -----------------------------------------------------------------------------
// Checklists
// -----------------------------------------------------------------------------

router.get("/qa/checklists", async (_req: Request, res: Response) => {
  const allResults = await db.select().from(qaChecklistResults);
  const resultsByKey = new Map<string, (typeof allResults)[number]>();
  for (const r of allResults) {
    resultsByKey.set(`${r.checklistId}/${r.itemId}`, r);
  }
  const checklists = QA_CHECKLISTS.map((c) => {
    const items = c.items.map((item: QaChecklistItem) => {
      const result = resultsByKey.get(`${c.id}/${item.id}`);
      return {
        id: item.id,
        label: item.label,
        hint: item.hint ?? null,
        status: result?.status ?? null,
        note: result?.note ?? null,
        updatedAt: result ? result.updatedAt.toISOString() : null,
      };
    });
    const counts = items.reduce(
      (acc, i) => {
        if (i.status === "pass") acc.passed += 1;
        else if (i.status === "fail") acc.failed += 1;
        else if (i.status === "skip") acc.skipped += 1;
        else acc.notRun += 1;
        return acc;
      },
      { passed: 0, failed: 0, skipped: 0, notRun: 0 },
    );
    return {
      id: c.id,
      app: c.app,
      title: c.title,
      description: c.description,
      total: items.length,
      counts,
      items,
    };
  });
  res.json({ checklists });
});

const UpdateChecklistItemBody = z.object({
  status: z.enum(["pass", "fail", "skip"]).nullable(),
  note: z.string().max(2000).nullable().optional(),
});

router.patch(
  "/qa/checklists/:checklistId/items/:itemId",
  async (req: Request, res: Response) => {
    const checklistId = String(req.params.checklistId ?? "").trim();
    const itemId = String(req.params.itemId ?? "").trim();
    const checklist = getChecklistById(checklistId);
    if (!checklist) {
      res.status(404).json({ error: "checklist_not_found" });
      return;
    }
    if (!checklist.items.find((i) => i.id === itemId)) {
      res.status(404).json({ error: "item_not_found" });
      return;
    }
    const parsed = UpdateChecklistItemBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const { status, note } = parsed.data;
    if (status === null) {
      await db
        .delete(qaChecklistResults)
        .where(
          and(
            eq(qaChecklistResults.checklistId, checklistId),
            eq(qaChecklistResults.itemId, itemId),
          ),
        );
      res.json({ checklistId, itemId, status: null, note: null });
      return;
    }
    const updatedAt = new Date();
    await db
      .insert(qaChecklistResults)
      .values({ checklistId, itemId, status, note: note ?? null, updatedAt })
      .onConflictDoUpdate({
        target: [qaChecklistResults.checklistId, qaChecklistResults.itemId],
        set: { status, note: note ?? null, updatedAt },
      });
    res.json({
      checklistId,
      itemId,
      status,
      note: note ?? null,
      updatedAt: updatedAt.toISOString(),
    });
  },
);

router.post(
  "/qa/checklists/:checklistId/reset",
  async (req: Request, res: Response) => {
    const checklistId = String(req.params.checklistId ?? "").trim();
    const checklist = getChecklistById(checklistId);
    if (!checklist) {
      res.status(404).json({ error: "checklist_not_found" });
      return;
    }
    await db
      .delete(qaChecklistResults)
      .where(eq(qaChecklistResults.checklistId, checklistId));
    res.json({ ok: true });
  },
);

// -----------------------------------------------------------------------------
// Autopilot (Task #482)
// -----------------------------------------------------------------------------

function serializeAutopilotRun(
  row: {
    id: string;
    status: string;
    trigger: string;
    startedAt: Date;
    finishedAt: Date | null;
    totalSuites: number;
    passing: number;
    failing: number;
    flaky: number;
    autoFixesApplied: number;
    needsReview: number;
    notes: string;
  },
): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.finishedAt
      ? row.finishedAt.getTime() - row.startedAt.getTime()
      : null,
    totalSuites: row.totalSuites,
    passing: row.passing,
    failing: row.failing,
    flaky: row.flaky,
    autoFixesApplied: row.autoFixesApplied,
    needsReview: row.needsReview,
    notes: row.notes,
  };
}

router.get("/qa/autopilot", async (_req: Request, res: Response) => {
  const [enabled, latest] = await Promise.all([
    isAutopilotEnabled(),
    getLatestAutopilotRun(),
  ]);
  res.json({
    enabled,
    activeRunId: getActiveAutopilotRunId(),
    latestRun: latest ? serializeAutopilotRun(latest) : null,
  });
});

const UpdateAutopilotSettingsBody = z.object({
  enabled: z.boolean(),
});

router.patch("/qa/autopilot/settings", async (req: Request, res: Response) => {
  const parsed = UpdateAutopilotSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  await setSetting("autopilot.enabled", parsed.data.enabled ? "true" : "false");
  res.json({ enabled: parsed.data.enabled });
});

const StartAutopilotBody = z.object({
  trigger: z.enum(["manual", "auto-on-open"]).default("manual"),
});

router.post("/qa/autopilot/runs", async (req: Request, res: Response) => {
  const parsed = StartAutopilotBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await startAutopilotRun(parsed.data.trigger);
    res
      .status(201)
      .json({ runId: result.runId, startedAt: result.startedAt.toISOString() });
  } catch (err) {
    if (err instanceof AutopilotAlreadyRunningError) {
      res.status(409).json({ error: "already_running", runId: err.runId });
      return;
    }
    logger.error({ err }, "qa: failed to start autopilot run");
    res.status(500).json({ error: "start_failed" });
  }
});

router.get("/qa/autopilot/runs", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query["limit"] ?? 25) || 25, 100);
  const rows = await listAutopilotRuns(limit);
  res.json({ runs: rows.map(serializeAutopilotRun) });
});

router.get("/qa/autopilot/runs/:runId", async (req: Request, res: Response) => {
  const runId = String(req.params.runId ?? "").trim();
  const detail = await getAutopilotRunDetail(runId);
  if (!detail) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }
  res.json({
    run: serializeAutopilotRun(detail.run),
    findings: detail.findings.map((f) => ({
      id: f.id,
      autopilotRunId: f.autopilotRunId,
      suiteId: f.suiteId,
      qaRunId: f.qaRunId,
      testName: f.testName,
      filePath: f.filePath,
      line: f.line,
      errorExcerpt: f.errorExcerpt,
      category: f.category,
      severity: f.severity,
      autoFixStatus: f.autoFixStatus,
      plainSummary: f.plainSummary,
      suggestedDiff: f.suggestedDiff,
      createdAt: f.createdAt.toISOString(),
    })),
    fixActions: detail.fixActions.map((a) => ({
      id: a.id,
      autopilotRunId: a.autopilotRunId,
      findingId: a.findingId,
      fixerId: a.fixerId,
      suiteId: a.suiteId,
      command: a.command,
      filesChanged: JSON.parse(a.filesChanged) as string[],
      success: a.success,
      log: a.log,
      startedAt: a.startedAt.toISOString(),
      finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
    })),
  });
});

export default router;
