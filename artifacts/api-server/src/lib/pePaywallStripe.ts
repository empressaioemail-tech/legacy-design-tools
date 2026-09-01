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
 *   STRIPE_TEAM_PRICE_ID           Smart Site Team   $299/mo (covers 3 seats)
 *   STRIPE_TEAM_SEAT_PRICE_ID      Smart Site Team additional seat $25/mo
 *   STRIPE_PE_UNLOCK_PRICE_ID      $15 one-time 30-day property unlock
 *   STRIPE_SOLO_ANNUAL_PRICE_ID    Smart Site Solo   $490/yr  (ruled 2026-08-24)
 *   STRIPE_STUDIO_ANNUAL_PRICE_ID  Smart Site Studio $1,290/yr
 *   STRIPE_TEAM_ANNUAL_PRICE_ID    Smart Site Team   $2,990/yr (covers 3 seats)
 *
 * FAIL CLOSED: a tier whose price id is not configured refuses checkout
 * (PeCheckoutConfigError -> 503) rather than defaulting to any other
 * tier's price. The retired STRIPE_PRO_PRICE_ID / STRIPE_MAX_PRICE_ID pair
 * is never read here — that pair charged the pre-ladder $29/$65 amounts
 * (2026-08-24 pricing audit) and remains only in the install-scoped
 * brokerage extension seam.
 */

import { eq } from "drizzle-orm";
import {
  db,
  peUserEntitlements,
  type PeBillingInterval,
  type PeSubscriptionTier,
} from "@workspace/db";
import { logger } from "./logger";
import {
  createStripePortalSessionForCustomer,
  isStripeConfigured,
  stripePostForm,
  stripePublishableKey,
  type StripeCheckoutResult,
} from "./brokerageStripe";
import { setPeStripeCustomerId } from "./peIdentity";
import {
  PE_TEAM_INCLUDED_SEATS,
  type StripePriceItem,
} from "./peTeamSeatsFromStripe";

export { PE_TEAM_INCLUDED_SEATS } from "./peTeamSeatsFromStripe";

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
 * covers 3 seats). There is NO annual extra-seat price: extra seats stay
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

/**
 * `"month" | "year"`. Defined once, on the column that stores it
 * (`pe_user_entitlements.billing_interval`, migration 0092), and re-exported
 * here so checkout, the webhook, and the store cannot drift into two
 * vocabularies for one fact.
 */
export type { PeBillingInterval };

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

/**
 * Every price id we have configured for one interval, across all three
 * ladder tiers. Read through {@link stripePriceIdForPeTier} rather than
 * `process.env` directly, so this file has exactly ONE place that knows
 * which env name carries which (tier, interval) pair. Unset and blank env
 * vars are dropped by that helper and never enter the set — a sentinel must
 * not be able to match.
 */
function configuredPeTierPriceIds(
  interval: PeBillingInterval,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tier of PE_SUBSCRIPTION_TIERS) {
    const id = stripePriceIdForPeTier(tier, interval);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * INVERSE of {@link stripePriceIdForPeTier}: which interval did WE configure
 * this price id under? (P-98.)
 *
 * The billed price id is an opaque identifier we chose and put in env
 * ourselves, so mapping it back through our own config is a derivation from
 * a source we control. That is deliberately NOT `price.recurring.interval`,
 * `plan.interval`, or `current_period_end`: those are Stripe API fields
 * whose shape moves with the API version, and nothing in this repo pins a
 * version.
 *
 * FAIL CLOSED. A price id that matches nothing we configured returns null —
 * never "month". So does a price id configured under BOTH a monthly and an
 * annual env name: that is a misconfiguration, we cannot tell which one the
 * customer was billed under, and a guess would be a fabricated fact about
 * their billing.
 */
export function peBillingIntervalForPriceId(
  priceId: string | null | undefined,
): PeBillingInterval | null {
  if (typeof priceId !== "string") return null;
  const needle = priceId.trim();
  if (!needle) return null;
  const isMonthly = configuredPeTierPriceIds("month").has(needle);
  const isAnnual = configuredPeTierPriceIds("year").has(needle);
  // Neither (unknown price) and both (ambiguous config) are the same
  // answer: we do not know, so we say so.
  if (isMonthly === isAnnual) return null;
  return isMonthly ? "month" : "year";
}

/**
 * The interval a subscription's billed line items were priced at.
 *
 * Items that match no configured price id are SKIPPED, not treated as a
 * refusal — a Team subscription legitimately carries the $25 extra-seat
 * line alongside its base price, and only the base price is in the tier
 * config. Two items resolving to DIFFERENT intervals is a contradiction
 * (Stripe requires one interval per subscription) and refuses with null
 * rather than taking the first. No matching item at all is also null:
 * unknown, never "month".
 */
export function peBillingIntervalFromPriceItems(
  items: readonly StripePriceItem[],
): PeBillingInterval | null {
  let resolved: PeBillingInterval | null = null;
  for (const item of items) {
    const interval = peBillingIntervalForPriceId(item.priceId);
    if (!interval) continue;
    if (resolved !== null && resolved !== interval) return null;
    resolved = interval;
  }
  return resolved;
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

/**
 * Checkout chrome. Stripe 2026-03-25 retired `custom` / `hosted` /
 * `embedded` on the Session. We still accept those PE aliases and map
 * them: custom|elements → `elements`, embedded → `embedded_page`.
 * Hosted / absent omits ui_mode (Stripe default `hosted_page`).
 */
export type PeCheckoutUiMode = "hosted" | "custom" | "embedded" | "elements";

export function isCustomPeCheckoutUiMode(
  uiMode: PeCheckoutUiMode | undefined,
): boolean {
  return (
    uiMode === "custom" || uiMode === "elements" || uiMode === "embedded"
  );
}

/** Value posted to Stripe. Never the retired `custom` / `hosted` / `embedded`. */
export function stripeUiModeForPe(
  uiMode: PeCheckoutUiMode | undefined,
): "elements" | "embedded_page" | null {
  if (uiMode === "custom" || uiMode === "elements") return "elements";
  if (uiMode === "embedded") return "embedded_page";
  return null;
}

/**
 * Stripe Custom / Embedded Checkout requires `return_url` and the
 * `{CHECKOUT_SESSION_ID}` placeholder. Hosted success/cancel URLs are
 * unchanged; this helper is only used on the custom path.
 */
export function peCustomCheckoutReturnUrl(returnUrl?: string): string {
  const base = returnUrl?.trim() || defaultPeCheckoutSuccessUrl();
  if (base.includes("{CHECKOUT_SESSION_ID}")) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}session_id={CHECKOUT_SESSION_ID}`;
}

function applyPeCheckoutUiMode(
  params: Record<string, string>,
  input: {
    uiMode?: PeCheckoutUiMode;
    returnUrl?: string;
    successUrl: string;
    cancelUrl: string;
  },
): boolean {
  const stripeUiMode = stripeUiModeForPe(input.uiMode);
  if (stripeUiMode) {
    params.ui_mode = stripeUiMode;
    params.return_url = peCustomCheckoutReturnUrl(input.returnUrl);
    return true;
  }
  params.success_url = input.successUrl;
  params.cancel_url = input.cancelUrl;
  return false;
}

function livePeCheckoutFromSession(
  session: Record<string, unknown>,
  opts: {
    custom: boolean;
    publishableKey: string | null;
    peTier?: PeSubscriptionCheckoutTier;
    peInterval?: PeBillingInterval;
  },
): StripeCheckoutResult {
  if (opts.custom) {
    const sessionId =
      typeof session.id === "string" && session.id.trim() ? session.id : "";
    const clientSecret =
      typeof session.client_secret === "string" && session.client_secret.trim()
        ? session.client_secret
        : "";
    if (!sessionId || !clientSecret) {
      throw new Error("Stripe checkout session missing id or client_secret");
    }
    return {
      mode: "live",
      sessionId,
      clientSecret,
      publishableKey: opts.publishableKey,
      ...(opts.peTier
        ? { peTier: opts.peTier, peInterval: opts.peInterval }
        : {}),
    };
  }
  const sessionId = String(session.id);
  const checkoutUrl = String(session.url);
  if (!sessionId || !checkoutUrl) {
    throw new Error("Stripe checkout session missing id or url");
  }
  return {
    mode: "live",
    sessionId,
    checkoutUrl,
    publishableKey: opts.publishableKey,
    ...(opts.peTier
      ? { peTier: opts.peTier, peInterval: opts.peInterval }
      : {}),
  };
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
  returnUrl?: string;
  /** Absent defaults to hosted (today's checkoutUrl redirect). */
  uiMode?: PeCheckoutUiMode;
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
      `annual Team checkout supports at most the ${PE_TEAM_INCLUDED_SEATS} included seats — extra seats bill monthly only`,
    );
  }

  const publishableKey = stripePublishableKey();
  const custom = isCustomPeCheckoutUiMode(input.uiMode);

  if (!isStripeConfigured()) {
    // Keyless dev/test seam only — a configured deployment never lands here.
    logger.info(
      { userId: input.userId.slice(0, 8), tier, interval, custom },
      "pe-stripe: simulated subscription checkout (no STRIPE_SECRET_KEY)",
    );
    if (custom) {
      const sessionId = `cs_test_sim_${input.userId.slice(0, 8)}_${Date.now()}`;
      return {
        mode: "simulated",
        sessionId,
        clientSecret: `${sessionId}_secret_sim`,
        publishableKey,
        peTier: tier,
        peInterval: interval,
        note: `Stripe credentials not configured — simulated PE ${tier} ${interval} checkout`,
      };
    }
    const sessionId = `sim_cs_${input.userId.slice(0, 8)}_${Date.now()}`;
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
  if (tier === "team") {
    const billedSeats = String(PE_TEAM_INCLUDED_SEATS + extraSeats);
    params["metadata[seats_purchased]"] = billedSeats;
    params["subscription_data[metadata][seats_purchased]"] = billedSeats;
  }
  applyPeCheckoutUiMode(params, input);
  if (extraSeats > 0 && seatPriceId) {
    params["line_items[1][price]"] = seatPriceId;
    params["line_items[1][quantity]"] = String(extraSeats);
  }
  if (input.installId) {
    params["metadata[install_id]"] = input.installId;
  }
  const session = await stripePostForm("/checkout/sessions", params);
  return livePeCheckoutFromSession(session, {
    custom,
    publishableKey,
    peTier: tier,
    peInterval: interval,
  });
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
  returnUrl?: string;
  /** Absent defaults to hosted (today's checkoutUrl redirect). */
  uiMode?: PeCheckoutUiMode;
}): Promise<StripeCheckoutResult> {
  const publishableKey = stripePublishableKey();
  const custom = isCustomPeCheckoutUiMode(input.uiMode);

  if (!isStripeConfigured()) {
    // Keyless dev/test seam only.
    logger.info(
      {
        userId: input.userId.slice(0, 8),
        parcelNodeId: input.parcelNodeId,
        custom,
      },
      "pe-stripe: simulated property-unlock checkout (no STRIPE_SECRET_KEY)",
    );
    if (custom) {
      const sessionId = `cs_test_sim_unlock_${input.userId.slice(0, 8)}_${Date.now()}`;
      return {
        mode: "simulated",
        sessionId,
        clientSecret: `${sessionId}_secret_sim`,
        publishableKey,
        note: "Stripe credentials not configured — simulated unlock checkout",
      };
    }
    const sessionId = `sim_cs_unlock_${input.userId.slice(0, 8)}_${Date.now()}`;
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
    "metadata[pe_user_id]": input.userId,
    "metadata[parcel_node_id]": input.parcelNodeId,
    "metadata[checkout_kind]": "property_unlock" satisfies PeCheckoutKind,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
  };
  applyPeCheckoutUiMode(params, input);
  if (input.installId) {
    params["metadata[install_id]"] = input.installId;
  }
  const session = await stripePostForm("/checkout/sessions", params);
  return livePeCheckoutFromSession(session, { custom, publishableKey });
}

// ---------------------------------------------------------------------------
// A-062 — THE PE USER-SCOPED STRIPE CUSTOMER PORTAL.
//
// WHY THIS EXISTS. `apps/property-explorer/public/terms.html` tells every
// customer "You can cancel a paid plan through the Stripe billing flow in the
// product." Until this function there was no such flow for a PE user: the only
// portal in the codebase was `brokerageStripe.createBillingPortalSession`,
// which is keyed on an EXTENSION INSTALL ID and resolves a
// `brokerage_wallets.stripe_customer_id`. A PE subscriber's customer lives on
// `pe_user_entitlements.stripe_customer_id` and the two are different columns
// on different rows for different subjects. Reusing the install seam for a
// signed-in web user would open the wrong customer's portal, or create a
// customer that never pays.
//
// WHAT IS SHARED AND WHAT IS NOT. The HTTP call is shared —
// `createStripePortalSessionForCustomer` in brokerageStripe.ts is the single
// `/billing_portal/sessions` poster and both seams go through it. The CUSTOMER
// RESOLUTION is deliberately not shared, because the two seams need opposite
// behaviour on a missing customer: the install seam creates one, and this one
// must never create one (acceptance item 2).
//
// THE READ IS NOT `getOrCreatePeStripeCustomer`. That function is one letter
// of intent away and would satisfy every "did we get a customer id" check
// while silently registering a Stripe customer for a free user who merely
// clicked "cancel subscription" to see what it said. Asking to manage billing
// is not a purchase and must leave no trace in Stripe.
// ---------------------------------------------------------------------------

/**
 * The path A-062 mounts, exported so the route and its test name the same
 * string once. The client half (hauska-map `src/lib/portalClient.ts`) carries
 * the proxy-side spelling of the same path and the two are pinned
 * independently on each side of the wire.
 */
export const PE_BILLING_PORTAL_ROUTE = "/property-explorer/v1/billing/portal";

/**
 * ABSENT IS NOT AN ERROR AND NOT A ZERO. A signed-in user with no Stripe
 * customer is the ordinary state of every free account and every account that
 * abandoned a checkout, so it gets its own arm of the result type rather than
 * a thrown error or an empty string. The compiler makes every consumer handle
 * it; no `if (!customerId)` can be forgotten.
 */
export type PeBillingPortalResult =
  | { kind: "portal"; mode: "live"; portalUrl: string }
  /** The account has never had a Stripe customer. Declared, not fabricated. */
  | { kind: "no-billing-account" }
  /**
   * Stripe is not configured on this deployment, so no portal can be opened.
   *
   * DELIBERATELY NOT SIMULATED, unlike the install-scoped seam, which returns
   * a fake `?simulated_portal=1` bounce. A simulated portal cannot cancel a
   * subscription, and this route exists precisely because a cancellation
   * promise the product could not honour was the defect. Handing back a URL
   * that looks like a portal and cancels nothing would re-create it one layer
   * down.
   */
  | { kind: "not-configured" };

/**
 * Read-only lookup of the PE user's Stripe customer id.
 *
 * Exported so a test can prove the no-customer path without reaching Stripe.
 * Returns `null` for both "no entitlement row" and "row with a null customer"
 * because the customer is what the caller needs and both mean it is absent;
 * the two are not otherwise distinguished by anything downstream.
 */
export async function readPeStripeCustomerId(
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ stripeCustomerId: peUserEntitlements.stripeCustomerId })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, userId))
    .limit(1);
  const id = row?.stripeCustomerId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Open a Stripe Customer Portal session for a signed-in PE user (A-062).
 *
 * `userId` MUST come from the authenticated session. The route that calls this
 * refuses a caller-supplied customer id outright rather than ignoring it, so
 * there is no path by which a request body reaches this argument.
 *
 * `returnUrl` is REQUIRED and has no default here. The historical default,
 * `peWebAppBaseUrl()`, falls back to the hardcoded
 * `https://property-explorer-xi.vercel.app` when PE_WEB_APP_BASE_URL is unset,
 * which would land a Smart Site customer on a stale Vercel host after
 * cancelling. A required argument makes that a compile error rather than a
 * silent wrong destination (acceptance item 4).
 */
export async function createPeBillingPortalSession(input: {
  /** Resolved from the authenticated session by the route. Never from a body. */
  userId: string;
  /** Explicit. No default — see the note above. */
  returnUrl: string;
}): Promise<PeBillingPortalResult> {
  if (!isStripeConfigured()) {
    return { kind: "not-configured" };
  }

  // READ, never get-or-create. See the header note.
  const customerId = await readPeStripeCustomerId(input.userId);
  if (!customerId) {
    logger.info(
      { userId: input.userId.slice(0, 8) },
      "pe-stripe: billing portal refused — account has no stripe customer",
    );
    return { kind: "no-billing-account" };
  }

  const session = await createStripePortalSessionForCustomer({
    customerId,
    returnUrl: input.returnUrl,
  });
  return { kind: "portal", mode: session.mode, portalUrl: session.portalUrl };
}

/**
 * Hosts a portal `return_url` may land a customer on (A-062 item 4).
 *
 * THIS IS AN ALLOWLIST, NOT A SANITISER. An unrecognised host is refused; it
 * is never rewritten to a "safe" one, because silently redirecting a customer
 * somewhere other than where the caller asked is the same class of defect as
 * the stale hardcoded default this card removes — a wrong destination nobody
 * is told about.
 *
 * Derived, in order: an explicit `PE_PORTAL_RETURN_HOSTS` (comma separated),
 * else the host of `PE_WEB_APP_BASE_URL` when it is set, plus the Smart Site
 * production hosts, plus Vercel preview hosts, plus loopback outside
 * production. The Vercel arm is here because PE checkout ALREADY returns to
 * `window.location.origin` on a preview deployment; a portal stricter than the
 * checkout beside it would refuse a flow the product already permits, and a
 * control that blocks work it was never meant to reach teaches the fleet to
 * route around it.
 */
export function peAllowedReturnHosts(): string[] {
  const explicit = process.env.PE_PORTAL_RETURN_HOSTS?.trim();
  if (explicit) {
    return explicit
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }
  const hosts = new Set<string>(["smartsite.cloud", "www.smartsite.cloud"]);
  const configured = process.env.PE_WEB_APP_BASE_URL?.trim();
  if (configured) {
    try {
      hosts.add(new URL(configured).hostname.toLowerCase());
    } catch {
      // A malformed PE_WEB_APP_BASE_URL contributes NOTHING rather than a
      // guessed host. The two production entries above still stand.
    }
  }
  return [...hosts];
}

/**
 * Is this a return URL we will hand to Stripe?
 *
 * Pure and exported so the rule is testable without a request. Refuses on a
 * parse failure, on any scheme other than https (http only on loopback, for
 * local dev), and on a host outside {@link peAllowedReturnHosts} — with the
 * Vercel preview and loopback arms named explicitly rather than folded into a
 * regex nobody can read.
 */
export function isAllowedPeReturnUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return false;
  }
  if (loopback) return process.env.NODE_ENV !== "production";
  if (peAllowedReturnHosts().includes(host)) return true;
  // Vercel preview deployments for this app. Exact suffix, so `vercel.app`
  // itself and `notvercel.app` are both refused.
  return host.endsWith(".vercel.app");
}
