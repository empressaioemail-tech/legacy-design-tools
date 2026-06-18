/**
 * Investor deal radar funnel events + digest metrics (76f).
 * Lead-feed events omitted per 2026-06-17 scope cut.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db, gtmEvents } from "@workspace/db";

export const INVESTOR_FUNNEL_EVENT_TYPES = [
  "radar_autorun",
  "deal_kept",
  "deal_passed",
  "session_return",
  "paywall_hit",
  "upgrade_started",
  "subscription_active",
  "churned",
] as const;

export type InvestorFunnelEventType = (typeof INVESTOR_FUNNEL_EVENT_TYPES)[number];

export function isInvestorFunnelEventType(
  eventType: string,
): eventType is InvestorFunnelEventType {
  return (INVESTOR_FUNNEL_EVENT_TYPES as readonly string[]).includes(eventType);
}

export type InvestorFunnelMetrics = {
  windowDays: number;
  since: string;
  funnel: Array<{ step: string; eventType: string; count: number }>;
  upgrades: { paywall_hit: number; upgrade_started: number; subscription_active: number; churned: number };
};

const FUNNEL_STEPS: Array<{ step: string; eventType: string }> = [
  { step: "install", eventType: "extension_install" },
  { step: "first_radar", eventType: "radar_autorun" },
  { step: "deal_kept", eventType: "deal_kept" },
  { step: "deal_passed", eventType: "deal_passed" },
  { step: "session_return", eventType: "session_return" },
  { step: "brief_started", eventType: "brief_started" },
  { step: "brief_completed", eventType: "brief_completed" },
  { step: "paywall_hit", eventType: "paywall_hit" },
  { step: "upgrade_started", eventType: "upgrade_started" },
  { step: "subscription_active", eventType: "subscription_active" },
  { step: "churned", eventType: "churned" },
];

export async function computeInvestorFunnelMetrics(
  since: Date,
  windowDays: number,
): Promise<InvestorFunnelMetrics> {
  const counts = await db
    .select({
      eventType: gtmEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(gtmEvents)
    .where(gte(gtmEvents.createdAt, since))
    .groupBy(gtmEvents.eventType);

  const byType = new Map(counts.map((r) => [r.eventType, r.count]));

  const funnel = FUNNEL_STEPS.map(({ step, eventType }) => ({
    step,
    eventType,
    count: byType.get(eventType) ?? 0,
  }));

  return {
    windowDays,
    since: since.toISOString(),
    funnel,
    upgrades: {
      paywall_hit: byType.get("paywall_hit") ?? 0,
      upgrade_started: byType.get("upgrade_started") ?? 0,
      subscription_active: byType.get("subscription_active") ?? 0,
      churned: byType.get("churned") ?? 0,
    },
  };
}

export type QualifiedProspect = {
  installId: string;
  eventId: string;
  eventType: string;
  intentScore: number;
  conversionOpportunity: string;
};

/** Qualified = high intent on investor funnel or external MCP with high conversion. */
export function isQualifiedProspect(input: {
  eventType: string;
  intentScore: number;
  conversionOpportunity: string;
}): boolean {
  if (isInvestorFunnelEventType(input.eventType)) {
    return (
      input.eventType === "paywall_hit" ||
      input.eventType === "upgrade_started" ||
      input.intentScore >= 70
    );
  }
  return input.conversionOpportunity === "high" && input.intentScore >= 60;
}

export async function listRecentQualifiedProspects(
  since: Date,
  limit = 20,
): Promise<QualifiedProspect[]> {
  const rows = await db
    .select({
      id: gtmEvents.id,
      installId: gtmEvents.installId,
      eventType: gtmEvents.eventType,
      payloadJson: gtmEvents.payloadJson,
    })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        sql`${gtmEvents.eventType} IN ('paywall_hit', 'upgrade_started', 'radar_autorun', 'deal_kept', 'mcp_tool_call')`,
      ),
    )
    .orderBy(sql`${gtmEvents.createdAt} DESC`)
    .limit(limit);

  const out: QualifiedProspect[] = [];
  for (const row of rows) {
    const payload = row.payloadJson ?? {};
    const intentScore =
      typeof payload.intentScore === "number" ? payload.intentScore : 50;
    const conversionOpportunity =
      typeof payload.conversionOpportunity === "string"
        ? payload.conversionOpportunity
        : "medium";
    if (
      !isQualifiedProspect({
        eventType: row.eventType,
        intentScore,
        conversionOpportunity,
      })
    ) {
      continue;
    }
    out.push({
      installId: row.installId,
      eventId: row.id,
      eventType: row.eventType,
      intentScore,
      conversionOpportunity,
    });
  }
  return out;
}
