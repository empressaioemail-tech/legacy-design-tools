/**
 * The outbox's `local` leg: project one lifecycle event onto the Smart Site
 * contact record (`ss_contact`, the system of record from P-492 onward).
 *
 * Pure: given the contact as it stands (or null when the record has never
 * seen this user) and the event, return the contact as it should stand, the
 * derived events to enqueue in the same transaction, and the event data the
 * Resend leg sends. The Postgres half (`ssContactProjection.drizzle.ts`) runs
 * this inside one transaction with the contact row locked.
 *
 * Contract v2 rules (`_inbox/2026-10-03_ghl_to_resend_PLAN_integration_end.md` s4):
 *   - stage moves forward only (`ssContactStage.ts`);
 *   - `ss.became_sharer` once per contact, ever: the first share the record sees;
 *   - `previous_plan` on plan started / cancelled is the plan the record held
 *     BEFORE this event, and is omitted (never guessed) when the record did not
 *     exist yet;
 *   - `ss.went_quiet` only on a real transition (14 days without a session);
 *     `ss.came_back` on the first session after it.
 */

import { resolveSourceTag } from "./peCampaignSource";
import {
  becameSharerIdempotencyKey,
  cameBackIdempotencyKey,
} from "./peLifecycleOutbox";
import { nextStage, stageForPlan, type LifecycleStage } from "./ssContactStage";
import type {
  LifecycleEventType,
  SsBilling,
  SsPlan,
  SsSource,
} from "./peLifecycleTypes";

export const QUIET_AFTER_DAYS = 14;

export type ContactState = {
  userId: string;
  email: string;
  firstName: string | null;
  stage: LifecycleStage;
  plan: SsPlan;
  billing: SsBilling;
  source: SsSource | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  savedLots: number;
  shares: number;
  /** ISO date (YYYY-MM-DD). */
  lastActive: string | null;
  quiet: boolean;
  quietSince: Date | null;
  claudeConnected: boolean;
  becameSharerAt: Date | null;
};

export type ProjectionEvent = {
  userId: string;
  email: string;
  eventType: LifecycleEventType;
  payload: Record<string, unknown>;
};

export type Followup = { event: LifecycleEventType; idempotencyKey: string };

export type ProjectionPlan = {
  contact: ContactState;
  followups: Followup[];
  resendEvent: Record<string, unknown> | null;
  suppressResend?: string;
};

const SOURCE_BY_TAG: Record<string, SsSource> = {
  ss_src_ad: "ad",
  ss_src_group: "group",
  ss_src_page: "page",
  ss_src_share: "share",
  ss_src_direct: "direct",
};

const PLANS: readonly SsPlan[] = ["free", "unlock", "solo", "studio", "team"];
const BILLINGS: readonly SsBilling[] = ["monthly", "annual", "none"];

function asPlan(v: unknown): SsPlan | undefined {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v)
    ? (v as SsPlan)
    : undefined;
}

function asBilling(v: unknown): SsBilling | undefined {
  return typeof v === "string" && (BILLINGS as readonly string[]).includes(v)
    ? (v as SsBilling)
    : undefined;
}

function asCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
}

/**
 * First token of the display name, when it looks like a name. A display name
 * that is an email address (or empty) yields no first name rather than a
 * fabricated one. So does one that is the email's local part, or a handle
 * carrying digits, "+" or "_": an email sign-in's display name is its address
 * local part (measured 2026-10-03: "empressaioemail+ssc1"), and a greeting
 * that reads "Hi empressaioemail+ssc1," is worse than "Hi there,".
 */
export function firstNameFrom(displayName: unknown, email?: string): string | null {
  if (typeof displayName !== "string") return null;
  const trimmed = displayName.trim();
  if (!trimmed || trimmed.includes("@")) return null;
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!first || first.length > 40) return null;
  if (/[0-9+_]/.test(first)) return null;
  // Exact match only: an email sign-in's display name IS the local part, as
  // typed. "Jane Smith" with jane@ is a real name and is kept.
  const local = email?.split("@")[0]?.trim();
  if (local && trimmed === local) return null;
  return first;
}

export function emptyContact(userId: string, email: string): ContactState {
  return {
    userId,
    email,
    firstName: null,
    stage: "Explorer",
    plan: "free",
    billing: "none",
    source: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    savedLots: 0,
    shares: 0,
    lastActive: null,
    quiet: false,
    quietSince: null,
    claudeConnected: false,
    becameSharerAt: null,
  };
}

/**
 * What the money tables say about a user, read when the contact record first
 * sees them (P-492b). `row` is their `pe_user_entitlements` row, or null when
 * none exists. Only the Stripe webhook ledger writes a paid row. Sign-in
 * inserts a free one. So an absent row means no payment was ever recorded,
 * and free is a reading of that, not a default.
 */
export type EntitlementFacts = {
  row: {
    accessTier: string;
    subscriptionTier: string | null;
    billingInterval: string | null;
  } | null;
  /** An unlock with no expiry or an expiry still in the future. */
  hasLiveUnlock: boolean;
};

export type SeedResult = { ok: true; contact: ContactState } | { ok: false; error: string };

const PAID_TIERS: readonly SsPlan[] = ["solo", "studio", "team"];

/**
 * The contact a user starts from when the record first sees them: plan,
 * billing and stage derived from what they have paid for. Without this, a
 * paid subscriber whose first projected event is not E1 (a scan, a save, a
 * session) was written as free (measured on production 2026-10-03: a Studio
 * annual subscriber projected as free and Explorer). A paid row that names
 * no tier or no interval cannot be read and refuses rather than guessing.
 */
export function seedContact(userId: string, email: string, facts: EntitlementFacts): SeedResult {
  const c = emptyContact(userId, email);
  const row = facts.row;
  if (row && row.accessTier === "paid") {
    const tier = row.subscriptionTier;
    if (tier === null) {
      // Paid with no tier is an unlock-only grant, or a row this code cannot read.
      if (!facts.hasLiveUnlock) return { ok: false, error: "entitlement_paid_without_tier" };
    } else {
      if (!(PAID_TIERS as readonly string[]).includes(tier)) {
        return { ok: false, error: `entitlement_tier_unknown:${tier}` };
      }
      const billing =
        row.billingInterval === "year" ? "annual" : row.billingInterval === "month" ? "monthly" : null;
      if (!billing) return { ok: false, error: "entitlement_paid_without_interval" };
      c.plan = tier as SsPlan;
      c.billing = billing;
      c.stage = stageForPlan(c.plan) ?? "Explorer";
      return { ok: true, contact: c };
    }
  }
  if (facts.hasLiveUnlock) {
    c.plan = "unlock";
    c.stage = "Unlock";
  }
  return { ok: true, contact: c };
}

function daysBetween(isoDate: string, now: Date): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.floor((today - then) / 86_400_000);
}

export function isStale(lastActive: string | null, now: Date): boolean {
  return lastActive !== null && daysBetween(lastActive, now) >= QUIET_AFTER_DAYS;
}

export function projectEvent(
  current: ContactState | null,
  event: ProjectionEvent,
  now: Date,
  /** The contact a first-seen user starts from (`seedContact`). Ignored when `current` exists. */
  seed?: ContactState,
): ProjectionPlan {
  const existed = current !== null;
  const c: ContactState = current
    ? { ...current, email: event.email || current.email }
    : seed
      ? { ...seed, email: event.email || seed.email }
      : emptyContact(event.userId, event.email);
  const p = event.payload;
  const followups: Followup[] = [];
  let resendEvent: Record<string, unknown> | null = null;
  let suppressResend: string | undefined;

  if (!c.firstName) {
    const first = firstNameFrom(p["displayName"], c.email);
    if (first) c.firstName = first;
  }

  switch (event.eventType) {
    case "e1_account_created": {
      c.stage = nextStage({ event: event.eventType, currentStage: c.stage });
      const firstTouchUnset =
        c.source === null &&
        c.utmSource === null &&
        c.utmMedium === null &&
        c.utmCampaign === null &&
        c.utmContent === null;
      if (firstTouchUnset) {
        const resolution = resolveSourceTag(p["campaign"]);
        c.utmSource = resolution.campaign.utm_source ?? null;
        c.utmMedium = resolution.campaign.utm_medium ?? null;
        c.utmCampaign = resolution.campaign.utm_campaign ?? null;
        c.utmContent = resolution.campaign.utm_content ?? null;
        c.source = resolution.kind === "unmapped" ? null : SOURCE_BY_TAG[resolution.tag]!;
      }
      break;
    }
    case "e2_lot_saved": {
      const n = asCount(p["savedLots"]);
      if (n !== undefined) c.savedLots = n;
      break;
    }
    case "e3_share_sent": {
      const n = asCount(p["shares"]);
      if (n !== undefined) c.shares = n;
      c.stage = nextStage({ event: event.eventType, currentStage: c.stage });
      if (c.becameSharerAt === null) {
        c.becameSharerAt = now;
        followups.push({
          event: "became_sharer",
          idempotencyKey: becameSharerIdempotencyKey(c.userId),
        });
      }
      break;
    }
    case "became_sharer": {
      c.stage = nextStage({ event: event.eventType, currentStage: c.stage });
      if (c.becameSharerAt === null) c.becameSharerAt = now;
      break;
    }
    case "e4_unlock_bought": {
      c.stage = nextStage({ event: event.eventType, currentStage: c.stage });
      if (c.plan === "free") c.plan = "unlock";
      break;
    }
    case "e5_plan_started": {
      const previous = existed ? c.plan : null;
      const plan = asPlan(p["plan"]);
      const billing = asBilling(p["billing"]);
      if (plan) c.plan = plan;
      if (billing) c.billing = billing;
      c.stage = nextStage({
        event: event.eventType,
        currentStage: c.stage,
        ...(plan ? { plan } : {}),
      });
      resendEvent = previous ? { previous_plan: previous } : null;
      break;
    }
    case "plan_cancelled": {
      const previous = existed ? c.plan : null;
      c.plan = "free";
      c.billing = "none";
      resendEvent = previous ? { previous_plan: previous } : null;
      break;
    }
    case "claude_connected": {
      if (c.claudeConnected) suppressResend = "already_claude_connected";
      c.claudeConnected = true;
      break;
    }
    case "went_quiet": {
      if (!existed || c.quiet) {
        suppressResend = "not_a_quiet_transition";
      } else if (!isStale(c.lastActive, now)) {
        suppressResend = "active_again_before_projection";
      } else {
        c.quiet = true;
        c.quietSince = now;
      }
      break;
    }
    case "came_back":
      break;
    case "e6_last_active": {
      const day = typeof p["lastActive"] === "string" ? p["lastActive"] : null;
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) c.lastActive = day;
      if (c.quiet) {
        followups.push({
          event: "came_back",
          idempotencyKey: cameBackIdempotencyKey(c.userId, c.quietSince ?? now),
        });
        c.quiet = false;
        c.quietSince = null;
      }
      break;
    }
    case "affiliate_applied":
    case "affiliate_approved":
      throw new Error(`projection_not_applicable:${event.eventType}`);
  }

  return {
    contact: c,
    followups,
    resendEvent,
    ...(suppressResend ? { suppressResend } : {}),
  };
}

/** Contract v2 Smart Site contact properties, as Resend receives them. */
export function ssContactProperties(c: ContactState): Record<string, string | number> {
  const props: Record<string, string | number> = {
    ss_stage: c.stage,
    ss_plan: c.plan,
    ss_billing: c.billing,
    ss_saved_lots: c.savedLots,
    ss_shares: c.shares,
    ss_quiet: c.quiet ? "true" : "false",
    ss_claude_connected: c.claudeConnected ? "true" : "false",
  };
  if (c.source) props["ss_source"] = c.source;
  if (c.lastActive) props["ss_last_active"] = c.lastActive;
  return props;
}
