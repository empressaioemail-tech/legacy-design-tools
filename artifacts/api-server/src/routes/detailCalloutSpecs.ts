/**
 * L4 — `detail-callout-spec` endpoints (Cortex Lane C.4 / C.4.4).
 *
 *   POST /api/engagements/:engagementId/detail-callout-specs   create
 *   POST /api/detail-callout-specs/:specId/push-state          transition
 *   POST /api/detail-callout-specs/:specId/aps-ref             write APS ref
 *   GET  /api/engagements/:engagementId/detail-callout-specs   list
 *   GET  /api/detail-callout-specs/:specId                     fetch
 *
 * All routes gated by {@link requireServiceTokenOrSession}. Responses
 * are full atom instances conforming to `DETAIL_CALLOUT_SPEC_SCHEMA`.
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L4.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  engagements,
  detailCalloutSpecs,
  type DetailCalloutSpec as DetailCalloutSpecRow,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type DetailCalloutSpecAtomInstance,
  type DetailCalloutSpec,
  type DetailCalloutPushState,
} from "@workspace/atoms-l-surface";
import { logger } from "../lib/logger";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { L_SURFACE_SOURCE_ADAPTER, contentHashOf } from "../lib/lSurfaceAtom";
import {
  UUID_RE,
  resolveTenantId,
  resolveEventActor,
  recordLSurfaceEvent,
} from "../lib/lSurfaceRoute";
import {
  LEGAL_PUSH_TRANSITIONS,
  isLegalPushTransition,
  parseApsRefBody,
  parseCreateDetailCalloutSpecBody,
  parsePushStateBody,
  parsePushStateFilter,
  pushStateTransitionEvent,
} from "./detailCalloutSpec.logic";

const router: IRouter = Router();

router.use(requireServiceTokenOrSession);

/** Materialize a `detail-callout-spec` atom instance from its row. */
function toDetailCalloutSpecAtom(
  row: DetailCalloutSpecRow,
  tenantId: string,
): DetailCalloutSpecAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    engagementId: row.engagementId,
    spec: row.spec as DetailCalloutSpec,
    pushState: row.pushState as DetailCalloutPushState,
    apsTaskRef: row.apsTaskRef,
    findingId: row.findingId,
    responseTaskId: row.responseTaskId,
    createdAt: createdAtIso,
    pushedAt: row.pushedAt ? row.pushedAt.toISOString() : null,
    actorId: row.actorId,
    principalActorId: row.principalActorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "detail-callout-spec",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

async function loadSpec(specId: string): Promise<DetailCalloutSpecRow | null> {
  const rows = await db
    .select()
    .from(detailCalloutSpecs)
    .where(eq(detailCalloutSpecs.id, specId))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*    POST /api/engagements/:engagementId/detail-callout-specs  — create        */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/detail-callout-specs",
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

    const parsed = parseCreateDetailCalloutSpecBody(req.body);
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
        .insert(detailCalloutSpecs)
        .values({
          engagementId,
          spec: parsed.value.spec,
          pushState: "pending",
          findingId: parsed.value.findingId,
          responseTaskId: parsed.value.responseTaskId,
          actorId: parsed.value.actorId,
          principalActorId: parsed.value.principalActorId,
        })
        .returning();
      if (!row) throw new Error("detail_callout_specs insert returned no row");

      const atom = toDetailCalloutSpecAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "detail-callout-spec",
        entityId: row.id,
        eventType: "detail-callout-spec.created",
        actor: resolveEventActor(req),
        payload: { engagementId, detailType: parsed.value.spec.detailType },
      });

      res.status(201).json({ detailCalloutSpec: atom });
    } catch (err) {
      reqLog.error({ err, engagementId }, "create detail-callout-spec failed");
      res.status(500).json({ error: "Failed to create detail callout spec" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/engagements/:engagementId/detail-callout-specs  — list        */
/* -------------------------------------------------------------------------- */

router.get(
  "/engagements/:engagementId/detail-callout-specs",
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

    const filter = parsePushStateFilter(req.query.pushState);
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
          ? eq(detailCalloutSpecs.engagementId, engagementId)
          : and(
              eq(detailCalloutSpecs.engagementId, engagementId),
              eq(detailCalloutSpecs.pushState, filter.value),
            );

      const rows = await db
        .select()
        .from(detailCalloutSpecs)
        .where(where)
        .orderBy(desc(detailCalloutSpecs.createdAt));

      const tenantId = resolveTenantId(req);
      res.json({
        detailCalloutSpecs: rows.map((r) =>
          toDetailCalloutSpecAtom(r, tenantId),
        ),
      });
    } catch (err) {
      reqLog.error({ err, engagementId }, "list detail-callout-specs failed");
      res.status(500).json({ error: "Failed to list detail callout specs" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/detail-callout-specs/:specId  — fetch                        */
/* -------------------------------------------------------------------------- */

router.get(
  "/detail-callout-specs/:specId",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const specId =
      typeof req.params.specId === "string" ? req.params.specId : "";

    if (!UUID_RE.test(specId)) {
      res.status(404).json({ error: "detail_callout_spec_not_found" });
      return;
    }

    try {
      const row = await loadSpec(specId);
      if (!row) {
        res.status(404).json({ error: "detail_callout_spec_not_found" });
        return;
      }
      res.json({
        detailCalloutSpec: toDetailCalloutSpecAtom(row, resolveTenantId(req)),
      });
    } catch (err) {
      reqLog.error({ err, specId }, "fetch detail-callout-spec failed");
      res.status(500).json({ error: "Failed to fetch detail callout spec" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       POST /api/detail-callout-specs/:specId/push-state  — transition        */
/* -------------------------------------------------------------------------- */

router.post(
  "/detail-callout-specs/:specId/push-state",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const specId =
      typeof req.params.specId === "string" ? req.params.specId : "";

    if (!UUID_RE.test(specId)) {
      res.status(404).json({ error: "detail_callout_spec_not_found" });
      return;
    }

    const parsed = parsePushStateBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const to = parsed.value;

    try {
      const row = await loadSpec(specId);
      if (!row) {
        res.status(404).json({ error: "detail_callout_spec_not_found" });
        return;
      }

      const from = row.pushState as DetailCalloutPushState;
      if (!isLegalPushTransition(from, to)) {
        res.status(409).json({
          error: "illegal_push_transition",
          from,
          to,
          legalNextStates: LEGAL_PUSH_TRANSITIONS[from],
        });
        return;
      }

      const now = new Date();
      const [updated] = await db
        .update(detailCalloutSpecs)
        .set({
          pushState: to,
          // Entering `pushed` stamps `pushedAt`; other transitions
          // leave the existing stamp in place.
          pushedAt: to === "pushed" ? now : row.pushedAt,
          updatedAt: now,
        })
        .where(eq(detailCalloutSpecs.id, specId))
        .returning();
      if (!updated) {
        throw new Error("detail_callout_specs update returned no row");
      }

      const atom = toDetailCalloutSpecAtom(updated, resolveTenantId(req));
      const eventType = pushStateTransitionEvent(to);
      if (eventType) {
        await recordLSurfaceEvent(reqLog, {
          entityType: "detail-callout-spec",
          entityId: updated.id,
          eventType,
          actor: resolveEventActor(req),
          payload: { from, to },
        });
      }

      res.json({ detailCalloutSpec: atom });
    } catch (err) {
      reqLog.error(
        { err, specId },
        "transition detail-callout-spec push-state failed",
      );
      res.status(500).json({ error: "Failed to update push state" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       POST /api/detail-callout-specs/:specId/aps-ref  — write APS ref         */
/* -------------------------------------------------------------------------- */

router.post(
  "/detail-callout-specs/:specId/aps-ref",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const specId =
      typeof req.params.specId === "string" ? req.params.specId : "";

    if (!UUID_RE.test(specId)) {
      res.status(404).json({ error: "detail_callout_spec_not_found" });
      return;
    }

    const parsed = parseApsRefBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const existing = await loadSpec(specId);
      if (!existing) {
        res.status(404).json({ error: "detail_callout_spec_not_found" });
        return;
      }

      const [row] = await db
        .update(detailCalloutSpecs)
        .set({ apsTaskRef: parsed.value, updatedAt: new Date() })
        .where(eq(detailCalloutSpecs.id, specId))
        .returning();
      if (!row) throw new Error("detail_callout_specs update returned no row");

      const atom = toDetailCalloutSpecAtom(row, resolveTenantId(req));
      // `detail-callout-spec.aps-ref-set` is descriptive — the L4
      // contract names no event for the aps-ref write. Flagged in the
      // C.4.4 PR.
      await recordLSurfaceEvent(reqLog, {
        entityType: "detail-callout-spec",
        entityId: row.id,
        eventType: "detail-callout-spec.aps-ref-set",
        actor: resolveEventActor(req),
        payload: { apsTaskRef: parsed.value },
      });

      res.json({ detailCalloutSpec: atom });
    } catch (err) {
      reqLog.error({ err, specId }, "write detail-callout-spec aps-ref failed");
      res.status(500).json({ error: "Failed to write APS ref" });
    }
  },
);

export default router;
