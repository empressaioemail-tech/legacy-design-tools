/**
 * Shared Express-layer helpers for the Cortex L-surface (L1-L6) routes
 * (Lane C.4).
 *
 * Extracted at C.4.2 so L2-L6 do not each re-implement tenant
 * resolution, event-actor resolution, and best-effort audit-event
 * append. (L1 / C.4.1 carries equivalent helpers inline in
 * `routes/responseTasks.ts`, shipped before this module existed.)
 */

import type { Request } from "express";
import { getHistoryService } from "../atoms/registry";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { logger } from "./logger";

/** Loose uuid-shape guard so a malformed path id is a clean 404, not a 500. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Actor envelope for the atom-event chain. */
export type EventActor = { kind: "user" | "agent" | "system"; id: string };

/**
 * Resolve the tenant for the request. legacy-design-tools is
 * single-tenant; both auth paths resolve to {@link DEFAULT_TENANT_ID}.
 */
export function resolveTenantId(req: Request): string {
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
export function resolveEventActor(req: Request): EventActor {
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

/**
 * Best-effort audit-event append. A history-write failure is logged
 * but never fails the mutation it accompanies — the row write is the
 * source of truth (same posture as `emitClassificationEvents`).
 */
export async function recordLSurfaceEvent(
  reqLog: typeof logger,
  params: {
    entityType: string;
    entityId: string;
    eventType: string;
    actor: EventActor;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await getHistoryService().appendEvent({
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      actor: params.actor,
      payload: params.payload,
    });
  } catch (err) {
    reqLog.error(
      {
        err,
        entityType: params.entityType,
        entityId: params.entityId,
        eventType: params.eventType,
      },
      "L-surface audit event append failed",
    );
  }
}
