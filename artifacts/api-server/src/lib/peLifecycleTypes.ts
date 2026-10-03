/**
 * Smart Site self-serve lifecycle — events, plans, and the Resend contract.
 *
 * Spec: `_inbox/2026-09-24_marketing_build_spec_NICK.md` sections 1–2.
 * Contract v2 (the names both seats build against):
 * `_inbox/2026-10-03_ghl_to_resend_PLAN_integration_end.md` section 4.
 * Decision: `_decisions/2026-10-03_ghl_retired_lifecycle_to_resend.md`.
 *
 * A name in this file changes in the plan's section 4 first, or not at all.
 */

export {
  STAGES,
  highestStage,
  nextStage,
  stageForPlan,
  stageIndex,
  type LifecycleStage,
} from "./ssContactStage";

export type SsPlan = "free" | "unlock" | "solo" | "studio" | "team";
export type SsBilling = "monthly" | "annual" | "none";
export type SsSource = "ad" | "group" | "page" | "share" | "direct";

/**
 * Internal outbox event types. E1–E6 keep their P-413 names because rows
 * already in `pe_lifecycle_outbox` carry them.
 */
export const LIFECYCLE_EVENTS = [
  "e1_account_created",
  "e2_lot_saved",
  "e3_share_sent",
  "e4_unlock_bought",
  "e5_plan_started",
  "e6_last_active",
  "became_sharer",
  "plan_cancelled",
  "claude_connected",
  "went_quiet",
  "came_back",
  "affiliate_applied",
  "affiliate_approved",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number];

/** Paid state comes only from money: these may only be enqueued by the Stripe webhook. */
export const PAID_LIFECYCLE_EVENTS: readonly LifecycleEventType[] = [
  "e4_unlock_bought",
  "e5_plan_started",
  "plan_cancelled",
];

export const AFFILIATE_LIFECYCLE_EVENTS: readonly LifecycleEventType[] = [
  "affiliate_applied",
  "affiliate_approved",
];

/**
 * Contract v2 event names sent to Resend. `null` = the event updates the
 * contact only and sends no event (E6, per the contract).
 */
export const RESEND_EVENT_NAMES: Record<LifecycleEventType, string | null> = {
  e1_account_created: "ss.account_created",
  e2_lot_saved: "ss.lot_saved",
  e3_share_sent: "ss.share_sent",
  became_sharer: "ss.became_sharer",
  e4_unlock_bought: "ss.unlock_bought",
  e5_plan_started: "ss.plan_started",
  plan_cancelled: "ss.plan_cancelled",
  claude_connected: "ss.claude_connected",
  went_quiet: "ss.went_quiet",
  came_back: "ss.came_back",
  e6_last_active: null,
  affiliate_applied: "affiliate.applied",
  affiliate_approved: "affiliate.approved",
};

/** Contract v2 Smart Site contact properties (besides `first_name`). */
export const SS_CONTACT_PROPERTIES = [
  "ss_stage",
  "ss_plan",
  "ss_billing",
  "ss_source",
  "ss_saved_lots",
  "ss_shares",
  "ss_last_active",
  "ss_quiet",
  "ss_claude_connected",
] as const;

export type SsContactProperty = (typeof SS_CONTACT_PROPERTIES)[number];

/** Resend property types (string or number only; booleans go as "true"/"false"). */
export const SS_CONTACT_PROPERTY_TYPES: Record<SsContactProperty, "string" | "number"> = {
  ss_stage: "string",
  ss_plan: "string",
  ss_billing: "string",
  ss_source: "string",
  ss_saved_lots: "number",
  ss_shares: "number",
  ss_last_active: "string",
  ss_quiet: "string",
  ss_claude_connected: "string",
};

/** Field name returned to the browser so P-414's pixel can share the id. */
export const LIFECYCLE_EVENT_ID_FIELD = "lifecycleEventId" as const;
