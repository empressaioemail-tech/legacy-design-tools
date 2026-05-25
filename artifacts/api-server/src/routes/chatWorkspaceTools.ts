/**
 * QA-45 — tools for workspace-scoped dashboard chat.
 */
import type { Request } from "express";
import {
  db,
  engagements,
  snapshots,
  atomEvents,
  architectNotificationReads,
} from "@workspace/db";
import { desc, eq, sql, and, gt, inArray } from "drizzle-orm";
import type { Scope } from "@hauska/atom-contract";
import type { AgentToolDefinition } from "./chatAgentTools";
import { logger } from "../lib/logger";

const MAX_LIST_ROWS = 50;

export interface WorkspaceToolContext {
  scope: Scope;
  req: Request;
  reqLog: typeof logger;
}

export interface ToolRunResult {
  resultText: string;
  isError?: boolean;
}

const EMPTY_INPUT = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

export const WORKSPACE_CHAT_TOOLS: AgentToolDefinition[] = [
  {
    name: "list_engagements",
    description:
      "List architect engagements (projects) with snapshot counts and attention flags.",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "summarize_inbox",
    description:
      "Summarize recent submission/reviewer activity and unread notification estimate.",
    input_schema: EMPTY_INPUT,
  },
];

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** One query for many engagements — avoids N+1 before workspace chat streams. */
export async function snapshotCountsForEngagements(
  engagementIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (engagementIds.length === 0) return counts;
  const rows = await db
    .select({
      engagementId: snapshots.engagementId,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(snapshots)
    .where(inArray(snapshots.engagementId, engagementIds))
    .groupBy(snapshots.engagementId);
  for (const row of rows) {
    counts.set(row.engagementId, Number(row.count) || 0);
  }
  return counts;
}

export function buildWorkspaceAgentToolGuidance(input: {
  activeTab: string | null;
}): string {
  const tabLine = input.activeTab
    ? ` The operator is on the "${input.activeTab}" surface.`
    : "";
  return (
    "\n\n" +
    "Tools: list_engagements, summarize_inbox." +
    tabLine +
    " Ground portfolio answers in tool output."
  );
}

async function handleListEngagements(): Promise<ToolRunResult> {
  const rows = await db
    .select()
    .from(engagements)
    .orderBy(desc(engagements.updatedAt))
    .limit(MAX_LIST_ROWS);

  const snapCounts = await snapshotCountsForEngagements(rows.map((e) => e.id));
  const enriched = rows.map((e) => {
    const snapCount = snapCounts.get(e.id) ?? 0;
    return {
      id: e.id,
      name: e.name,
      status: e.status,
      address: e.address,
      jurisdiction: e.jurisdiction,
      snapshotCount: snapCount,
      updatedAt: e.updatedAt.toISOString(),
      needsAttention:
        e.status === "active" &&
        (!e.address?.trim() || snapCount === 0 || !e.geocodedAt),
    };
  });

  return {
    resultText: asJson({
      engagementCount: enriched.length,
      engagements: enriched,
    }),
  };
}

async function handleSummarizeInbox(ctx: WorkspaceToolContext): Promise<ToolRunResult> {
  const userId = ctx.req.session?.requestor?.id ?? "anonymous";
  const [readRow] = await db
    .select()
    .from(architectNotificationReads)
    .where(eq(architectNotificationReads.userId, userId))
    .limit(1);
  const lastReadAt = readRow?.lastReadAt ?? new Date(0);

  const recentEvents = await db
    .select({
      entityType: atomEvents.entityType,
      eventType: atomEvents.eventType,
      occurredAt: atomEvents.occurredAt,
      payload: atomEvents.payload,
    })
    .from(atomEvents)
    .where(
      and(
        gt(atomEvents.occurredAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        sql`${atomEvents.eventType} LIKE '%submission%' OR ${atomEvents.eventType} LIKE '%reviewer-request%'`,
      ),
    )
    .orderBy(desc(atomEvents.occurredAt))
    .limit(20);

  const [{ unread }] = await db
    .select({ unread: sql<number>`cast(count(*) as int)` })
    .from(atomEvents)
    .where(gt(atomEvents.occurredAt, lastReadAt));

  return {
    resultText: asJson({
      unreadNotificationEstimate: Number(unread) || 0,
      recentActivityCount: recentEvents.length,
      recentActivity: recentEvents.map((e) => ({
        entityType: e.entityType,
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        payload: e.payload,
      })),
    }),
  };
}

export async function executeWorkspaceAgentTool(
  name: string,
  input: unknown,
  ctx: WorkspaceToolContext,
): Promise<ToolRunResult> {
  switch (name) {
    case "list_engagements":
      return handleListEngagements();
    case "summarize_inbox":
      return handleSummarizeInbox(ctx);
    default:
      return {
        resultText: `Error: unknown tool "${name}".`,
        isError: true,
      };
  }
}
