/**
 * Property Explorer user-authenticated Stripe checkout (WDLL 2026-08-05
 * items 2, 3; tier-aware per the LOCKED 2026-08-10 Smart Site ladder).
 * Distinct from `brokerageStripe.ts`'s install-scoped extension checkout:
 * these sessions are keyed on the signed-in PE `pe_user_id`, carry
 * `metadata.checkout_kind` so the shared webhook handler in
 * `brokerageStripe.ts` can route them, and support Stripe's built-in
 * promotion-code UI on the subscription path.
 *
 * Secret Manager names (shared STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY
 * with brokerageStripe.ts):
 *   STRIPE_SOLO_PRICE_ID           Smart Site Solo   $49/mo
 *   STRIPE_STUDIO_PRICE_ID         Smart Site Studio $129/mo
 *   STRIPE_TEAM_PRICE_ID           Smart Site Team   $299/mo (covers 10 seats)
 *   STRIPE_TEAM_SEAT_PRICE_ID      Smart Site Team additional seat $25/mo
 *   STRIPE_PE_UNLOCK_PRICE_ID      $15 one-time 30-day property unlock
 *   STRIPE_SOLO_ANNUAL_PRICE_ID    Smart Site Solo   $490/yr  (ruled 2026-08-24)
 *   STRIPE_STUDIO_ANNUAL_PRICE_ID  Smart Site Studio $1,290/yr
 *   STRIPE_TEAM_ANNUAL_PRICE_ID    Smart Site Team   $2,990/yr (covers 10 seats)
 *
 * FAIL CLOSED: a tier whose price id is not configured refuses checkout
 * (PeCheckoutConfigError -> 503) rather than defaulting to any other
 * tier's price. The retired STRIPE_PRO_PRICE_ID / STRIPE_MAX_PRICE_ID pair
 * is never read here — that pair charged the pre-ladder $29/$65 amounts
 * (2026-08-24 pricing audit) and remains only in the install-scoped
 * brokerage extension seam.
 */

import { eq } from "drizzle-orm";
import { db, peUserEntitlements, type PeSubscriptionTier } from "@workspace/db";
import { logger } from "./logger";
import {
  isStripeConfigured,
  stripePostForm,
  stripePublishableKey,
  type StripeCheckoutResult,
} from "./brokerageStripe";
import { setPeStripeCustomerId } from "./peIdentity";

/** Seats included in the Team base price (LOCKED ladder: "$299/mo for up to 10 seats"). */
export const PE_TEAM_INCLUDED_SEATS = 10;

/** 30-day bound on the $15 per-property unlock (LOCKED ladder). */
export const PE_PROPERTY_UNLOCK_DURATION_DAYS = 30;

export type PeSubscriptionCheckoutTier = PeSubscriptionTier;

const PE_SUBSCRIPTION_TIERS: readonly PeSubscriptionCheckoutTier[] = [
  "solo",
  "studio",
  "team",
];

export function isPeSubscriptionTier(
  value: unknown,
): value is PeSubscriptionCheckoutTier {
  return (
    typeof value === "string" &&
    (PE_SUBSCRIPTION_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Raised when checkout cannot proceed because required Stripe configuration
 * is absent. Routes map this to 503 `checkout_unavailable` — the customer
 * is never silently charged a different tier's price.
 */
export class PeCheckoutConfigError extends Error {
  readonly missing: string;
  constructor(missing: string) {
    super(`checkout unavailable: ${missing} is not configured`);
    this.name = "PeCheckoutConfigError";
    this.missing = missing;
  }
}

const TIER_PRICE_ENV: Record<PeSubscriptionCheckoutTier, string> = {
  solo: "STRIPE_SOLO_PRICE_ID",
  studio: "STRIPE_STUDIO_PRICE_ID",
  team: "STRIPE_TEAM_PRICE_ID",
};

/**
 * Annual prices, ratified by operator ruling 2026-08-24
 * (`_decisions/2026-08-24_stripe_annual_pricing_and_live_activation.md`):
 * two months free — Solo $490/yr, Studio $1,290/yr, Team $2,990/yr (base
 * covers 10 seats). There is NO annual extra-seat price: extra seats stay
 * monthly $25, and because Stripe Checkout requires every recurring line
 * item in one subscription to share a billing interval, an annual Team
 * checkout with more than the included seats is REFUSED rather than
 * silently split or silently billed monthly.
 */
export const TIER_ANNUAL_PRICE_ENV: Record<PeSubscriptionCheckoutTier, string> = {
  solo: "STRIPE_SOLO_ANNUAL_PRICE_ID",
  studio: "STRIPE_STUDIO_ANNUAL_PRICE_ID",
  team: "STRIPE_TEAM_ANNUAL_PRICE_ID",
};

export type PeBillingInterval = "month" | "year";

/**
 * Resolve the Stripe price id for a ladder tier + billing interval from
 * env. Returns `null` when unset — callers must refuse, never substitute
 * another tier's price and never another interval's price (an annual
 * request billed monthly charges a different amount than presented).
 */
export function stripePriceIdForPeTier(
  tier: PeSubscriptionCheckoutTier,
  interval: PeBillingInterval = "month",
): string | null {
  const envName =
    interval === "year" ? TIER_ANNUAL_PRICE_ENV[tier] : TIER_PRICE_ENV[tier];
  return process.env[envName]?.trim() || null;
}

export function stripeTeamSeatPriceId(): string | null {
  return process.env.STRIPE_TEAM_SEAT_PRICE_ID?.trim() || null;
}

export function stripePeUnlockPriceId(): string | null {
  return process.env.STRIPE_PE_UNLOCK_PRICE_ID?.trim() || null;
}

/** PE web-app origin for default checkout return URLs. */
export function peWebAppBaseUrl(): string {
  const raw = process.env.PE_WEB_APP_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return "https://property-explorer-xi.vercel.app";
}

/** WDLL item 7 — the return URL the PE app watches to re-poll `/entitlement`. */
export function defaultPeCheckoutSuccessUrl(): string {
  return `${peWebAppBaseUrl()}/?checkout=success`;
}

export function defaultPeCheckoutCancelUrl(): string {
  return `${peWebAppBaseUrl()}/?checkout=cancel`;
}

async function getOrCreatePeStripeCustomer(input: {
  userId: string;
  email?: string | null;
}): Promise<string> {
  const [row] = await db
    .select({ stripeCustomerId: peUserEntitlements.stripeCustomerId })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, input.userId))
    .limit(1);
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await stripePostForm("/customers", {
    "metadata[pe_user_id]": input.userId,
    description: `Property Explorer user ${input.userId.slice(0, 16)}`,
    ...(input.email ? { email: input.email } : {}),
  });
  const customerId = String(customer.id);
  await setPeStripeCustomerId(input.userId, customerId);
  return customerId;
}

/**
 * `pe_sub` is the tier-aware kind (carries `metadata.subscription_tier`);
 * `pro_sub` is the legacy pre-ladder kind still present on old sessions —
 * the webhook maps it to solo, never to studio/team.
 */
export type PeCheckoutKind = "pe_sub" | "pro_sub" | "property_unlock";

/**
 * Tier-aware subscription checkout for a signed-in PE user. Carries
 * `metadata.pe_user_id` + `metadata.subscription_tier` (webhook routes and
 * grants off these) and `allow_promotion_codes: true` so a tester can apply
 * a 100%-off promo code at the real Stripe Checkout UI and land in the same
 * paid path as a full payment (WDLL acceptance item 2).
 *
 * Team seats: `seats` is the TOTAL seat count desired. The base price
 * covers {@link PE_TEAM_INCLUDED_SEATS}; each seat above that adds one unit
 * of STRIPE_TEAM_SEAT_PRICE_ID ($25/mo). `seats` on a non-team tier is
 * rejected by the route schema before this function runs.
 */
export async function createPeSubscriptionCheckoutSession(input: {
  userId: string;
  tier: PeSubscriptionCheckoutTier;
  /** Billing interval — "month" default; "year" per the 2026-08-24 annual ruling. */
  interval?: PeBillingInterval;
  seats?: number;
  email?: string | null;
  installId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const { tier } = input;
  const interval: PeBillingInterval = input.interval ?? "month";
  if (!isPeSubscriptionTier(tier)) {
    // Route zod schema already rejects unknown strings; this guards
    // programmatic callers. Fail closed — no default tier.
    throw new PeCheckoutConfigError(`unknown subscription tier ${String(tier)}`);
  }
  if (interval !== "month" && interval !== "year") {
    throw new PeCheckoutConfigError(
      `unknown billing interval ${String(interval)}`,
    );
  }

  const extraSeats =
    tier === "team" && typeof input.seats === "number"
      ? Math.max(0, Math.ceil(input.seats) - PE_TEAM_INCLUDED_SEATS)
      : 0;
  if (extraSeats > 0 && interval === "year") {
    // No annual seat price exists (operator ruling 2026-08-24: seats stay
    // monthly $25), and Stripe Checkout cannot mix intervals in one
    // subscription. Refuse — never silently split the purchase or bill the
    // base monthly. Route zod schema already rejects this with 400; this
    // guards programmatic callers.
    throw new Error(
      "annual Team checkout supports at most the 10 included seats — extra seats bill monthly only",
    );
  }

  const publishableKey = stripePublishableKey();

  if (!isStripeConfigured()) {
    // Keyless dev/test seam only — a configured deployment never lands here.
    const sessionId = `sim_cs_${input.userId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { userId: input.userId.slice(0, 8), tier, interval },
      "pe-stripe: simulated subscription checkout (no STRIPE_SECRET_KEY)",
    );
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      sessionId,
      checkoutUrl: `${input.successUrl}${sep}simulated=1&session_id=${sessionId}&tier=${tier}&interval=${interval}`,
      publishableKey: null,
      peTier: tier,
      peInterval: interval,
      note: `Stripe credentials not configured — simulated PE ${tier} ${interval} checkout`,
    };
  }

  const priceId = stripePriceIdForPeTier(tier, interval);
  if (!priceId) {
    // FAIL CLOSED: never fall back to another tier's price (the pre-ladder
    // defect was every checkout collapsing to the $29 STRIPE_PRO_PRICE_ID),
    // and never bill an annual request monthly — that charges a different
    // amount than the one presented to the customer.
    throw new PeCheckoutConfigError(
      interval === "year" ? TIER_ANNUAL_PRICE_ENV[tier] : TIER_PRICE_ENV[tier],
    );
  }

  const seatPriceId = extraSeats > 0 ? stripeTeamSeatPriceId() : null;
  if (extraSeats > 0 && !seatPriceId) {
    throw new PeCheckoutConfigError("STRIPE_TEAM_SEAT_PRICE_ID");
  }

  const customerId = await getOrCreatePeStripeCustomer(input);
  const params: Record<string, string> = {
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: "true",
    "metadata[pe_user_id]": input.userId,
    "metadata[checkout_kind]": "pe_sub" satisfies PeCheckoutKind,
    "metadata[subscription_tier]": tier,
    // Observability only — the webhook grant keys off subscription_tier,
    // never the interval (an annual Solo is still Solo).
    "metadata[billing_interval]": interval,
    "subscription_data[metadata][pe_user_id]": input.userId,
    "subscription_data[metadata][subscription_tier]": tier,
    "subscription_data[metadata][billing_interval]": interval,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
  };
  if (extraSeats > 0 && seatPriceId) {
    params["line_items[1][price]"] = seatPriceId;
    params["line_items[1][quantity]"] = String(extraSeats);
  }
  if (input.installId) {
    params["metadata[install_id]"] = input.installId;
  }
  const session = await stripePostForm("/checkout/sessions", params);

  const sessionId = String(session.id);
  const checkoutUrl = String(session.url);
  if (!sessionId || !checkoutUrl) {
    throw new Error("Stripe checkout session missing id or url");
  }
  return {
    mode: "live",
    sessionId,
    checkoutUrl,
    publishableKey,
    peTier: tier,
    peInterval: interval,
  };
}

/**
 * $15 one-time per-property unlock checkout for a signed-in PE user. On
 * completion the shared webhook writes a `pe_property_unlocks` row bounded
 * to {@link PE_PROPERTY_UNLOCK_DURATION_DAYS} via
 * `createPePropertyUnlock({ source: "stripe", expiresAt })` — this function
 * only opens the Checkout Session. FAIL CLOSED when
 * STRIPE_PE_UNLOCK_PRICE_ID is absent on a configured deployment.
 */
export async function createPePropertyUnlockCheckoutSession(input: {
  userId: string;
  email?: string | null;
  parcelNodeId: string;
  installId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const publishableKey = stripePublishableKey();

  if (!isStripeConfigured()) {
    // Keyless dev/test seam only.
    const sessionId = `sim_cs_unlock_${input.userId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { userId: input.userId.slice(0, 8), parcelNodeId: input.parcelNodeId },
      "pe-stripe: simulated property-unlock checkout (no STRIPE_SECRET_KEY)",
    );
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      sessionId,
      checkoutUrl: `${input.successUrl}${sep}simulated=1&session_id=${sessionId}&unlock=1`,
      publishableKey: null,
      note: "Stripe credentials not configured — simulated unlock checkout",
    };
  }

  const priceId = stripePeUnlockPriceId();
  if (!priceId) {
    throw new PeCheckoutConfigError("STRIPE_PE_UNLOCK_PRICE_ID");
  }

  const customerId = await getOrCreatePeStripeCustomer(input);
  const params: Record<string, string> = {
    mode: "payment",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "metadata[pe_user_id]": input.userId,
    "metadata[parcel_node_id]": input.parcelNodeId,
    "metadata[checkout_kind]": "property_unlock" satisfies PeCheckoutKind,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
  };
  if (input.installId) {
    params["metadata[install_id]"] = input.installId;
  }
  const session = await stripePostForm("/checkout/sessions", params);

  const sessionId = String(session.id);
  const checkoutUrl = String(session.url);
  if (!sessionId || !checkoutUrl) {
    throw new Error("Stripe checkout session missing id or url");
  }
  return { mode: "live", sessionId, checkoutUrl, publishableKey };
}
