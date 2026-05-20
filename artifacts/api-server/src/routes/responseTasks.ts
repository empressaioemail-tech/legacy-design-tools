/**
 * L1 — `response-task` endpoints (Cortex Lane C.4 / C.4.1).
 *
 * Four routes, all gated by {@link requireServiceTokenOrSession} (the
 * hauska-mcp-server bearer path + the Cortex SPA browser-session path):
 *
 *   POST /api/engagements/:engagementId/response-tasks      create
 *   POST /api/response-tasks/:responseTaskId/state          transition
 *   GET  /api/engagements/:engagementId/response-tasks      list
 *   POST /api/response-tasks/:responseTaskId/link-finding   link a finding
 *
 * Each route returns a full `response-task` atom instance conforming to
 * `RESPONSE_TASK_SCHEMA` (`@workspace/atoms-l-surface`). Mutations
 * append an audit event through the shared `EventAnchoringService`.
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L1. Pure validation + transition logic lives in
 * `responseTasks.logic.ts` (unit-tested without a DB).
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db, engagements, responseTasks, type ResponseTask } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type ResponseTaskAtomInstance,
  type ResponseTaskState,
} from "@workspace/atoms-l-surface";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  requireServiceTokenOrSession,
} from "../middlewares/serviceAuth";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { L_SURFACE_SOURCE_ADAPTER, contentHashOf } from "../lib/lSurfaceAtom";
import {
  isLegalResponseTaskTransition,
  parseCreateResponseTaskBody,
  parseLinkFindingBody,
  parseStateBody,
  parseStateFilter,
  responseTaskTransitionEvent,
} from "./responseTasks.logic";

const router: IRouter = Router();

/** Every route on this router is an L-surface route — dual-auth gate. */
router.use(requireServiceTokenOrSession);

/** Loose uuid-shape guard so a malformed path id is a clean 404, not a 500. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Actor envelope for the atom-event chain. */
type EventActor = { kind: "user" | "agent" | "system"; id: string };

/**
 * Resolve the tenant for the request. legacy-design-tools is
 * single-tenant; both auth paths resolve to {@link DEFAULT_TENANT_ID}.
 */
function resolveTenantId(req: Request): string {
  return (
    req.serviceAuth?.tenantId ?? req.session?.tenantId ?? DEFAULT_TENANT_ID
  );
}

/**
 * Resolve the actor that produced an event. A bearer (MCP) request is
 * the `cortex-mcp` agent; a browser request carries the session
 * requestor when one is resolved, else a system fallback (the
 * production fail-closed anonymous applicant has no requestor).
 */
function resolveEventActor(req: Request): EventActor {
  if (req.serviceAuth) return { kind: "agent", id: "cortex-mcp" };
  const requestor = req.session?.requestor;
  if (requestor && requestor.id) {
    return {
      kind: requestor.kind === "agent" ? "agent" : "user",
      id: requestor.id,
    };
  }
  return { kind: "system", id: "legacy-design-tools" };
}

/** Materialize a `response-task` atom instance from its backing row. */
function toResponseTaskAtom(
  row: ResponseTask,
  tenantId: string,
): ResponseTaskAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    title: row.title,
    description: row.description,
    state: row.state as ResponseTaskState,
    createdAt: createdAtIso,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    sourceClientCommentId: row.sourceClientCommentId,
    findingId: row.findingId,
    engagementId: row.engagementId,
    actorId: row.actorId,
    principalActorId: row.principalActorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "response-task",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

/**
 * Best-effort audit-event append. A history-write failure is logged
 * but never fails the mutation it accompanies — the row write is the
 * source of truth (same posture as `emitClassificationEvents`).
 */
async function recordEvent(
  reqLog: typeof logger,
  params: {
    entityId: string;
    eventType: string;
    actor: EventActor;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await getHistoryService().appendEvent({
      entityType: "response-task",
      entityId: params.entityId,
      eventType: params.eventType,
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    reqLog.error(
      { err, entityId: params.entityId, eventType: params.eventType },
      "response-task audit event append failed",
    );
  }
}

/* -------------------------------------------------------------------------- */
/*       POST /api/engagements/:engagementId/response-tasks  — create         */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/response-tasks",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const parsed = parseCreateResponseTaskBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const [row] = await db
        .insert(responseTasks)
        .values({
          engagementId,
          title: parsed.value.title,
          description: parsed.value.description,
          state: "open",
          dueAt: parsed.value.dueAt ? new Date(parsed.value.dueAt) : null,
          sourceClientCommentId: parsed.value.sourceClientCommentId,
          findingId: parsed.value.findingId,
          actorId: parsed.value.actorId,
          principalActorId: parsed.value.principalActorId,
        })
        .returning();
      if (!row) throw new Error("response_tasks insert returned no row");

      const atom = toResponseTaskAtom(row, resolveTenantId(req));
      await recordEvent(reqLog, {
        entityId: row.id,
        eventType: "response-task.opened",
        actor: resolveEventActor(req),
        payload: {
          engagementId,
          title: atom.title,
          findingId: atom.findingId,
          sourceClientCommentId: atom.sourceClientCommentId,
        },
      });

      res.status(201).json({ responseTask: atom });
    } catch (err) {
      reqLog.error({ err, engagementId }, "create response-task failed");
      res.status(500).json({ error: "Failed to create response task" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/engagements/:engagementId/response-tasks  — list            */
/* -------------------------------------------------------------------------- */

router.get(
  "/engagements/:engagementId/response-tasks",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const filter = parseStateFilter(req.query.state);
    if (!filter.ok) {
      res.status(400).json({ error: filter.error });
      return;
    }

    try {
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const where =
        filter.value === null
          ? eq(responseTasks.engagementId, engagementId)
          : and(
              eq(responseTasks.engagementId, engagementId),
              eq(responseTasks.state, filter.value),
            );

      const rows = await db
        .select()
        .from(responseTasks)
        .where(where)
        .orderBy(desc(responseTasks.createdAt));

      const tenantId = resolveTenantId(req);
      res.json({
        responseTasks: rows.map((r) => toResponseTaskAtom(r, tenantId)),
      });
    } catch (err) {
      reqLog.error({ err, engagementId }, "list response-tasks failed");
      res.status(500).json({ error: "Failed to list response tasks" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       POST /api/response-tasks/:responseTaskId/state  — transition         */
/* -------------------------------------------------------------------------- */

router.post(
  "/response-tasks/:responseTaskId/state",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const responseTaskId =
      typeof req.params.responseTaskId === "string"
        ? req.params.responseTaskId
        : "";

    if (!UUID_RE.test(responseTaskId)) {
      res.status(404).json({ error: "response_task_not_found" });
      return;
    }

    const parsed = parseStateBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const nextState = parsed.value;

    try {
      const existingRows = await db
        .select()
        .from(responseTasks)
        .where(eq(responseTasks.id, responseTaskId))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        res.status(404).json({ error: "response_task_not_found" });
        return;
      }

      const fromState = existing.state as ResponseTaskState;
      if (!isLegalResponseTaskTransition(fromState, nextState)) {
        res
          .status(409)
          .json({ error: "response_task_transition_forbidden" });
        return;
      }

      const now = new Date();
      const [row] = await db
        .update(responseTasks)
        .set({
          state: nextState,
          // `completedAt` is stamped only while the task is `done`;
          // any other state clears it (a reopened task is not done).
          completedAt: nextState === "done" ? now : null,
          updatedAt: now,
        })
        .where(eq(responseTasks.id, responseTaskId))
        .returning();
      if (!row) throw new Error("response_tasks update returned no row");

      const atom = toResponseTaskAtom(row, resolveTenantId(req));
      await recordEvent(reqLog, {
        entityId: row.id,
        eventType: responseTaskTransitionEvent(nextState),
        actor: resolveEventActor(req),
        payload: { from: fromState, to: nextState },
      });

      res.json({ responseTask: atom });
    } catch (err) {
      reqLog.error(
        { err, responseTaskId },
        "transition response-task failed",
      );
      res.status(500).json({ error: "Failed to update response task" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*    POST /api/response-tasks/:responseTaskId/link-finding  — link finding   */
/* -------------------------------------------------------------------------- */

router.post(
  "/response-tasks/:responseTaskId/link-finding",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const responseTaskId =
      typeof req.params.responseTaskId === "string"
        ? req.params.responseTaskId
        : "";

    if (!UUID_RE.test(responseTaskId)) {
      res.status(404).json({ error: "response_task_not_found" });
      return;
    }

    const parsed = parseLinkFindingBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const existingRows = await db
        .select({ id: responseTasks.id })
        .from(responseTasks)
        .where(eq(responseTasks.id, responseTaskId))
        .limit(1);
      if (!existingRows[0]) {
        res.status(404).json({ error: "response_task_not_found" });
        return;
      }

      const [row] = await db
        .update(responseTasks)
        .set({ findingId: parsed.value, updatedAt: new Date() })
        .where(eq(responseTasks.id, responseTaskId))
        .returning();
      if (!row) throw new Error("response_tasks update returned no row");

      const atom = toResponseTaskAtom(row, resolveTenantId(req));
      // `response-task.linked-finding` is descriptive — it sits outside
      // the atom's declared 4-event vocabulary (opened/progressed/
      // completed/cancelled). The L1 contract names link-finding's
      // event only as "an audit event"; flagged in the C.4.1 PR.
      await recordEvent(reqLog, {
        entityId: row.id,
        eventType: "response-task.linked-finding",
        actor: resolveEventActor(req),
        payload: { findingId: parsed.value },
      });

      res.json({ responseTask: atom });
    } catch (err) {
      reqLog.error(
        { err, responseTaskId },
        "link finding to response-task failed",
      );
      res.status(500).json({ error: "Failed to link finding" });
    }
  },
);

export default router;
