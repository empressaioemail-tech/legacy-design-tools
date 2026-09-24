/**
 * Smart Site self-serve lifecycle — stages, tags, fields, events.
 *
 * Spec: `_inbox/2026-09-24_marketing_build_spec_NICK.md` sections 1–2.
 * Decision: `_decisions/2026-09-24_smart_site_lifecycle_pipeline_in_ghl.md`.
 */

export const PIPELINE_NAME = "Smart Site Self Serve";

export const STAGES = [
  "Explorer",
  "Sharer",
  "Unlock",
  "Solo",
  "Studio",
  "Team",
] as const;

export type LifecycleStage = (typeof STAGES)[number];

export const STAGE_TAGS: Record<LifecycleStage, string> = {
  Explorer: "ss_explorer",
  Sharer: "ss_sharer",
  Unlock: "ss_unlock",
  Solo: "ss_solo",
  Studio: "ss_studio",
  Team: "ss_team",
};

export const BILLING_TAGS = {
  monthly: "ss_monthly",
  annual: "ss_annual",
} as const;

export type SsPlan = "free" | "unlock" | "solo" | "studio" | "team";
export type SsBilling = "monthly" | "annual" | "none";

export const FIELD_NAMES = {
  savedLots: "SS Saved lots",
  shares: "SS Shares",
  lastActive: "SS Last active",
  plan: "SS Plan",
  billing: "SS Billing",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
} as const;

export const REQUIRED_TAGS = [
  "ss_explorer",
  "ss_sharer",
  "ss_unlock",
  "ss_solo",
  "ss_studio",
  "ss_team",
  "ss_monthly",
  "ss_annual",
  "ss_src_ad",
  "ss_src_group",
  "ss_src_page",
  "ss_src_share",
  "ss_src_direct",
] as const;

export const REQUIRED_FIELDS = Object.values(FIELD_NAMES);

export const LIFECYCLE_EVENTS = [
  "e1_account_created",
  "e2_lot_saved",
  "e3_share_sent",
  "e4_unlock_bought",
  "e5_plan_started",
  "e6_last_active",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number];

export function stageIndex(stage: LifecycleStage): number {
  return STAGES.indexOf(stage);
}

/**
 * Stages move forward only. A skip (Explorer → Solo with no share) is the
 * highest reached, not a walk through the ones in between.
 */
export function highestStage(
  current: LifecycleStage | null,
  next: LifecycleStage,
): LifecycleStage {
  if (!current) return next;
  return stageIndex(next) > stageIndex(current) ? next : current;
}

export function stageForPlan(plan: SsPlan): LifecycleStage | null {
  switch (plan) {
    case "unlock":
      return "Unlock";
    case "solo":
      return "Solo";
    case "studio":
      return "Studio";
    case "team":
      return "Team";
    case "free":
      return null;
  }
}

/** Field name returned to the browser so P-414's pixel can share the id. */
export const LIFECYCLE_EVENT_ID_FIELD = "lifecycleEventId" as const;
