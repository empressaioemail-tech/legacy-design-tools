import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  qaRuns,
  qaChecklistResults,
  qaTriageItems,
  QA_TRIAGE_SOURCE_KIND_VALUES,
  QA_TRIAGE_STATUS_VALUES,
  QA_TRIAGE_SEVERITY_VALUES,
  type QaTriageItem,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
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
  getAutopilotNotifyPublic,
  assertSafeWebhookUrl,
  WebhookValidationError,
  getAutopilotNotifySettings,
} from "../lib/qa/settings";
import { renderTriageBundle } from "../lib/qa/triageBundle";

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
    res.status(500).json({
      error: "start_failed",
      message: err instanceof Error ? err.message : String(err),
    });
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
  const [enabled, latest, notify] = await Promise.all([
    isAutopilotEnabled(),
    getLatestAutopilotRun(),
    getAutopilotNotifyPublic(),
  ]);
  res.json({
    enabled,
    activeRunId: getActiveAutopilotRunId(),
    latestRun: latest ? serializeAutopilotRun(latest) : null,
    notify,
  });
});

const NotifySettingsBody = z.object({
  // `webhook` is write-only and optional. Omit to leave the current
  // webhook untouched. Empty string explicitly disables notifications.
  // The full URL is treated as a bearer secret and is never returned
  // by the GET endpoint.
  webhook: z.string().max(2048).optional(),
  minSeverity: z.enum(["warning", "error"]),
});

const UpdateAutopilotSettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    notify: NotifySettingsBody.optional(),
  })
  .refine((v) => v.enabled !== undefined || v.notify !== undefined, {
    message: "must include enabled or notify",
  });

router.patch("/qa/autopilot/settings", async (req: Request, res: Response) => {
  const parsed = UpdateAutopilotSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  if (parsed.data.enabled !== undefined) {
    await setSetting(
      "autopilot.enabled",
      parsed.data.enabled ? "true" : "false",
    );
  }
  if (parsed.data.notify) {
    if (parsed.data.notify.webhook !== undefined) {
      const trimmed = parsed.data.notify.webhook.trim();
      if (trimmed.length > 0) {
        try {
          await assertSafeWebhookUrl(trimmed);
        } catch (err) {
          if (err instanceof WebhookValidationError) {
            res.status(400).json({
              error: "invalid_webhook_url",
              reason: err.code,
              message: err.message,
            });
            return;
          }
          throw err;
        }
      }
      await setSetting("autopilot.notify.webhook", trimmed);
    }
    await setSetting(
      "autopilot.notify.minSeverity",
      parsed.data.notify.minSeverity,
    );
  }
  const [enabled, notify] = await Promise.all([
    isAutopilotEnabled(),
    getAutopilotNotifyPublic(),
  ]);
  res.json({ enabled, notify });
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
    res.status(500).json({
      error: "start_failed",
      message: err instanceof Error ? err.message : String(err),
    });
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

// -----------------------------------------------------------------------------
// Notifications test (Task #503)
// -----------------------------------------------------------------------------

router.post(
  "/qa/autopilot/notifications/test",
  async (req: Request, res: Response) => {
    const settings = await getAutopilotNotifySettings();
    if (!settings.webhook) {
      res.status(412).json({
        error: "no_webhook_configured",
        message: "Configure a notification webhook before sending a test.",
      });
      return;
    }
    const payload = {
      source: "qa-autopilot",
      kind: "test",
      summary: "Test payload from QA dashboard.",
      sentAt: new Date().toISOString(),
      text: ":wave: QA dashboard webhook test — receiving end is wired up.",
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
      res.json({
        ok: resp.ok,
        status: resp.status,
        message: resp.ok
          ? `Webhook returned ${resp.status}.`
          : `Webhook returned non-2xx (${resp.status}).`,
      });
    } catch (err) {
      req.log.warn({ err }, "qa: notify test webhook threw");
      res.json({
        ok: false,
        status: null,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  },
);

// -----------------------------------------------------------------------------
// Triage queue (Task #503)
// -----------------------------------------------------------------------------

function serializeTriageItem(row: QaTriageItem): Record<string, unknown> {
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceRunId: row.sourceRunId,
    suiteId: row.suiteId,
    title: row.title,
    severity: row.severity,
    excerpt: row.excerpt,
    suggestedNextStep: row.suggestedNextStep,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
  };
}

router.get("/qa/triage", async (req: Request, res: Response) => {
  const statusParam = typeof req.query["status"] === "string" ? req.query["status"] : null;
  const allowed = QA_TRIAGE_STATUS_VALUES as readonly string[];
  const filter = statusParam && allowed.includes(statusParam) ? statusParam : null;
  const rows = await db
    .select()
    .from(qaTriageItems)
    .where(filter ? eq(qaTriageItems.status, filter) : undefined)
    .orderBy(desc(qaTriageItems.createdAt));
  // Counts always reflect the full table so the badge is honest even
  // when the caller asks for a single lane.
  const allRows = filter
    ? await db.select().from(qaTriageItems)
    : rows;
  const counts = { open: 0, sent: 0, done: 0, total: allRows.length };
  for (const r of allRows) {
    if (r.status === "open") counts.open += 1;
    else if (r.status === "sent") counts.sent += 1;
    else if (r.status === "done") counts.done += 1;
  }
  res.json({ items: rows.map(serializeTriageItem), counts });
});

const CreateTriageBody = z.object({
  sourceKind: z.enum(QA_TRIAGE_SOURCE_KIND_VALUES),
  sourceId: z.string().min(1).max(256),
  sourceRunId: z.string().max(256).nullable().optional(),
  suiteId: z.string().max(128).nullable().optional(),
  title: z.string().min(1).max(512),
  severity: z.enum(QA_TRIAGE_SEVERITY_VALUES).optional(),
  excerpt: z.string().max(8000).optional(),
  suggestedNextStep: z.string().max(2000).optional(),
});

router.post("/qa/triage", async (req: Request, res: Response) => {
  const parsed = CreateTriageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  // Dedupe: if there's already an Open item with the same source kind +
  // source id, return it instead of stacking duplicates.
  const [existing] = await db
    .select()
    .from(qaTriageItems)
    .where(
      and(
        eq(qaTriageItems.sourceKind, data.sourceKind),
        eq(qaTriageItems.sourceId, data.sourceId),
        eq(qaTriageItems.status, "open"),
      ),
    )
    .limit(1);
  if (existing) {
    res.status(201).json(serializeTriageItem(existing));
    return;
  }
  const [row] = await db
    .insert(qaTriageItems)
    .values({
      sourceKind: data.sourceKind,
      sourceId: data.sourceId,
      sourceRunId: data.sourceRunId ?? null,
      suiteId: data.suiteId ?? null,
      title: data.title,
      severity: data.severity ?? "error",
      excerpt: data.excerpt ?? "",
      suggestedNextStep: data.suggestedNextStep ?? "",
      status: "open",
    })
    .returning();
  if (!row) {
    res.status(500).json({ error: "insert_failed" });
    return;
  }
  res.status(201).json(serializeTriageItem(row));
});

const UpdateTriageBody = z.object({
  status: z.enum(QA_TRIAGE_STATUS_VALUES),
});

function timestampsForStatus(status: (typeof QA_TRIAGE_STATUS_VALUES)[number]): {
  sentAt: Date | null;
  doneAt: Date | null;
} {
  const now = new Date();
  if (status === "sent") return { sentAt: now, doneAt: null };
  if (status === "done") return { sentAt: null, doneAt: now };
  return { sentAt: null, doneAt: null };
}

const BulkUpdateBody = z.object({
  ids: z.array(z.string().uuid()).min(1),
  status: z.enum(QA_TRIAGE_STATUS_VALUES),
});

router.patch("/qa/triage/bulk", async (req: Request, res: Response) => {
  const parsed = BulkUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const ts = timestampsForStatus(parsed.data.status);
  const rows = await db
    .update(qaTriageItems)
    .set({
      status: parsed.data.status,
      sentAt: ts.sentAt,
      doneAt: ts.doneAt,
    })
    .where(inArray(qaTriageItems.id, parsed.data.ids))
    .returning();
  res.json({ updated: rows.map(serializeTriageItem) });
});

router.patch("/qa/triage/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").trim();
  const parsed = UpdateTriageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const ts = timestampsForStatus(parsed.data.status);
  const [row] = await db
    .update(qaTriageItems)
    .set({
      status: parsed.data.status,
      sentAt: ts.sentAt,
      doneAt: ts.doneAt,
    })
    .where(eq(qaTriageItems.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(serializeTriageItem(row));
});

router.delete("/qa/triage/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").trim();
  const deleted = await db
    .delete(qaTriageItems)
    .where(eq(qaTriageItems.id, id))
    .returning({ id: qaTriageItems.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

const BundleBody = z.object({
  ids: z.array(z.string().uuid()).optional(),
});

router.post("/qa/triage/bundle", async (req: Request, res: Response) => {
  const parsed = BundleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const rows = parsed.data.ids && parsed.data.ids.length > 0
    ? await db
        .select()
        .from(qaTriageItems)
        .where(inArray(qaTriageItems.id, parsed.data.ids))
        .orderBy(desc(qaTriageItems.createdAt))
    : await db
        .select()
        .from(qaTriageItems)
        .where(eq(qaTriageItems.status, "open"))
        .orderBy(desc(qaTriageItems.createdAt));

  const baseUrl = (() => {
    const domains = process.env["REPLIT_DOMAINS"];
    if (!domains) return null;
    const host = domains.split(",")[0]?.trim();
    return host ? `https://${host}` : null;
  })();
  const markdown = renderTriageBundle(rows, { baseUrl });
  res.json({
    markdown,
    items: rows.map(serializeTriageItem),
    count: rows.length,
  });
});

export default router;
