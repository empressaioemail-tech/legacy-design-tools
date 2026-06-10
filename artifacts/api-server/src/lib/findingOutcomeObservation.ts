/**
 * Arrow two Phase 2 — outcome-observation capture.
 *
 * Append-only `atom_events` rows anchored on the finding under test.
 * Partitioned by `jurisdictionTenant` (same key as Phase 1 ledger).
 */

import { z } from "zod";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db, findings, atomEvents } from "@workspace/db";
import { getHistoryService } from "../atoms/registry";
import { FINDING_OUTCOME_RECORDED_EVENT_TYPE } from "../atoms/finding.atom";
import {
  assertServiceTenantScope,
  resolveRequestJurisdictionTenant,
} from "./gateFrontSeam";
import { resolveFindingJurisdictionTenant } from "./gateFrontSeamEngagement";
import { logger } from "./logger";

export const FINDING_OUTCOME_KINDS = [
  "permit-approved",
  "variance-granted",
  "comment-resolved",
] as const;

export type FindingOutcomeKind = (typeof FINDING_OUTCOME_KINDS)[number];

export const RecordFindingOutcomeBody = z
  .object({
    outcomeKind: z.enum(FINDING_OUTCOME_KINDS),
    observedAt: z.string().datetime().optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

export type FindingOutcomeObservationRow = {
  eventId: string;
  findingAtomId: string;
  jurisdictionTenant: string;
  outcomeKind: FindingOutcomeKind;
  observedAt: string;
  notes: string | null;
  recordedAt: string;
};

export async function recordFindingOutcomeObservation(args: {
  findingAtomId: string;
  outcomeKind: FindingOutcomeKind;
  observedAt?: string;
  notes?: string | null;
  actor: { kind: "user" | "agent" | "system"; id: string };
  jurisdictionTenant: string;
}): Promise<{ eventId: string }> {
  const history = getHistoryService();
  const observedAt = args.observedAt ?? new Date().toISOString();
  const event = await history.appendEvent({
    entityType: "finding",
    entityId: args.findingAtomId,
    eventType: FINDING_OUTCOME_RECORDED_EVENT_TYPE,
    actor: args.actor,
    payload: {
      outcomeKind: args.outcomeKind,
      jurisdictionTenant: args.jurisdictionTenant,
      findingAtomId: args.findingAtomId,
      observedAt,
      notes: args.notes ?? null,
    },
  });
  return { eventId: event.id };
}

function parseOutcomePayload(payload: unknown): {
  outcomeKind: FindingOutcomeKind;
  jurisdictionTenant: string;
  observedAt: string;
  notes: string | null;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const outcomeKind = p.outcomeKind;
  const jurisdictionTenant = p.jurisdictionTenant;
  const observedAt = p.observedAt;
  if (
    typeof outcomeKind !== "string" ||
    !FINDING_OUTCOME_KINDS.includes(outcomeKind as FindingOutcomeKind)
  ) {
    return null;
  }
  if (typeof jurisdictionTenant !== "string" || !jurisdictionTenant.trim()) {
    return null;
  }
  return {
    outcomeKind: outcomeKind as FindingOutcomeKind,
    jurisdictionTenant: jurisdictionTenant.trim(),
    observedAt:
      typeof observedAt === "string" && observedAt.trim()
        ? observedAt
        : new Date(0).toISOString(),
    notes: typeof p.notes === "string" ? p.notes : null,
  };
}

export async function listFindingOutcomeObservations(options?: {
  jurisdictionTenant?: string | null;
  findingAtomId?: string | null;
}): Promise<{ rows: FindingOutcomeObservationRow[] }> {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;
  const findingFilter = (options?.findingAtomId ?? "").trim() || null;

  const eventRows = await db
    .select({
      eventId: atomEvents.id,
      entityId: atomEvents.entityId,
      payload: atomEvents.payload,
      recordedAt: atomEvents.recordedAt,
    })
    .from(atomEvents)
    .where(eq(atomEvents.eventType, FINDING_OUTCOME_RECORDED_EVENT_TYPE));

  const rows: FindingOutcomeObservationRow[] = [];
  for (const row of eventRows) {
    if (findingFilter && row.entityId !== findingFilter) continue;
    const parsed = parseOutcomePayload(row.payload);
    if (!parsed) continue;
    if (tenantFilter && parsed.jurisdictionTenant !== tenantFilter) continue;
    rows.push({
      eventId: row.eventId,
      findingAtomId: row.entityId,
      jurisdictionTenant: parsed.jurisdictionTenant,
      outcomeKind: parsed.outcomeKind,
      observedAt: parsed.observedAt,
      notes: parsed.notes,
      recordedAt: row.recordedAt.toISOString(),
    });
  }

  rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return { rows };
}

export async function handleRecordFindingOutcome(
  req: Request,
  findingAtomId: string,
  body: z.infer<typeof RecordFindingOutcomeBody>,
): Promise<
  | { ok: true; eventId: string; jurisdictionTenant: string }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const [finding] = await db
    .select({ atomId: findings.atomId })
    .from(findings)
    .where(eq(findings.atomId, findingAtomId))
    .limit(1);
  if (!finding) {
    return { ok: false, status: 404, body: { error: "finding_not_found" } };
  }

  const resourceTenant = await resolveFindingJurisdictionTenant(findingAtomId);
  const scope = assertServiceTenantScope(req, resourceTenant);
  if (!scope.ok) {
    return { ok: false, status: 403, body: { error: "tenant_scope_denied" } };
  }

  const jurisdictionTenant =
    resourceTenant ??
    resolveRequestJurisdictionTenant(req) ??
    "unknown-tenant";

  const actor = req.serviceAuth
    ? ({ kind: "agent" as const, id: "cortex-mcp" })
    : req.session?.requestor?.id
      ? {
          kind:
            req.session.requestor.kind === "agent"
              ? ("agent" as const)
              : ("user" as const),
          id: req.session.requestor.id,
        }
      : ({ kind: "system" as const, id: "legacy-design-tools" });

  try {
    const { eventId } = await recordFindingOutcomeObservation({
      findingAtomId,
      outcomeKind: body.outcomeKind,
      observedAt: body.observedAt,
      notes: body.notes ?? null,
      actor,
      jurisdictionTenant,
    });
    return { ok: true, eventId, jurisdictionTenant };
  } catch (err) {
    logger.error({ err, findingAtomId }, "finding outcome capture failed");
    return {
      ok: false,
      status: 500,
      body: { error: "finding_outcome_capture_failed" },
    };
  }
}
