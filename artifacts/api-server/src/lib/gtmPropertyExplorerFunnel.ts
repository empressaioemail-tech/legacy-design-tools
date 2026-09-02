/**
 * Property Explorer consumer funnel events + digest metrics (WDLL 24–27).
 * Reference model: investor funnel (76f) — not a trading clone.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db, gtmEvents } from "@workspace/db";

export {
  PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES,
  PE_GTM_CONSENT_VERSION,
  isPropertyExplorerFunnelEventType,
  isPropertyExplorerCrmEvent,
  peSyntheticEmail,
  type PropertyExplorerFunnelEventType,
} from "./gtmPropertyExplorerFunnelTypes";

export type PropertyExplorerFunnelMetrics = {
  windowDays: number;
  since: string;
  funnel: Array<{ step: string; eventType: string; count: number }>;
  upgrades: {
    pe_paywall_hit: number;
    pe_upgrade_started: number;
  };
};

const FUNNEL_STEPS: Array<{ step: string; eventType: string }> = [
  { step: "browse", eventType: "pe_browse_started" },
  { step: "cold_open_dismissed", eventType: "pe_cold_open_dismissed" },
  { step: "signup_intent", eventType: "pe_signup_intent" },
  { step: "save_property", eventType: "pe_save_property" },
  { step: "research_clicked", eventType: "pe_research_clicked" },
  { step: "paywall_hit", eventType: "pe_paywall_hit" },
  { step: "upgrade_started", eventType: "pe_upgrade_started" },
  { step: "share_created", eventType: "share_created" },
  { step: "share_viewed", eventType: "share_viewed" },
];

export async function computePropertyExplorerFunnelMetrics(
  since: Date,
  windowDays: number,
): Promise<PropertyExplorerFunnelMetrics> {
  const counts = await db
    .select({
      eventType: gtmEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        eq(gtmEvents.sourceSurface, "property-explorer"),
      ),
    )
    .groupBy(gtmEvents.eventType);

  const byType = new Map(counts.map((r) => [r.eventType, r.count]));

  return {
    windowDays,
    since: since.toISOString(),
    funnel: FUNNEL_STEPS.map(({ step, eventType }) => ({
      step,
      eventType,
      count: byType.get(eventType) ?? 0,
    })),
    upgrades: {
      pe_paywall_hit: byType.get("pe_paywall_hit") ?? 0,
      pe_upgrade_started: byType.get("pe_upgrade_started") ?? 0,
    },
  };
}
