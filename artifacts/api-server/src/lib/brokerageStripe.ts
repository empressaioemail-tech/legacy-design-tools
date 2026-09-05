/**
 * Stripe consumer subscription connector — keyless when STRIPE_* secrets absent.
 *
 * Secret Manager names (deploy when operator provides test keys):
 *   STRIPE_SECRET_KEY
 *   STRIPE_PUBLISHABLE_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRO_PRICE_ID
 *   STRIPE_MAX_PRICE_ID
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  brokerageWallets,
  type PeBillingInterval,
  type PeSubscriptionTier,
} from "@workspace/db";
import { logger } from "./logger";
import { setSubscriptionEntitlement } from "./brokerageEntitlement";
import { createPePropertyUnlock } from "./peEntitlement";
import { setPeAccessTierFromStripe } from "./peIdentity";
import { claimInstallHistoryForUser } from "./brokerageInstallClaim";
import { peBillingIntervalFromPriceItems } from "./pePaywallStripe";
import {
  configuredExtraSeatPriceId,
  configuredTeamPriceIds,
  extractStripePriceItems,
  parseMetadataSeats,
  resolveTeamSeatsPurchased,
  type StripePriceItem,
} from "./peTeamSeatsFromStripe";

/** 30-day unlock bound (LOCKED 2026-08-10 ladder: "$15, 30 days — not forever"). */
const PE_UNLOCK_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function isPeSubscriptionTierValue(v: unknown): v is PeSubscriptionTier {
  return v === "solo" || v === "studio" || v === "team";
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function stripePublishableKey(): string | null {
  return process.env.STRIPE_PUBLISHABLE_KEY?.trim() || null;
}

export function stripeProPriceId(): string | null {
  return process.env.STRIPE_PRO_PRICE_ID?.trim() || null;
}

export function stripeMaxPriceId(): string | null {
  return process.env.STRIPE_MAX_PRICE_ID?.trim() || null;
}

export type SubscriptionCheckoutTier = "pro" | "max";

/**
 * Raised when the legacy install-scoped (retired browser-extension) checkout
 * cannot proceed because its Stripe price id is unconfigured. Mirrors
 * `PeCheckoutConfigError` in `pePaywallStripe.ts` (routes map both to 503
 * `checkout_unavailable`) — kept as a separate class rather than imported
 * from there to avoid a circular import (`pePaywallStripe.ts` already
 * imports from this file).
 */
export class BrokerageCheckoutConfigError extends Error {
  readonly missing: string;
  constructor(missing: string) {
    super(`checkout unavailable: ${missing} is not configured`);
    this.name = "BrokerageCheckoutConfigError";
    this.missing = missing;
  }
}

function stripePriceIdForTier(tier: SubscriptionCheckoutTier): string | null {
  return tier === "max" ? stripeMaxPriceId() : stripeProPriceId();
}

/**
 * FAIL CLOSED. This seam served the retired browser extension's Pro/Max
 * tiers only (operator ruling 2026-09: the extension has been retired for
 * months and is not coming back — see OPS-16 A-061). A price id must match
 * ONE of the two configured tier prices EXACTLY to resolve; anything else —
 * including a Max subscriber whose price id no longer matches a stale or
 * unset STRIPE_MAX_PRICE_ID — returns null rather than silently downgrading
 * to "pro". The prior behaviour ("if it isn't Max, it's Pro") never checked
 * the price id against STRIPE_PRO_PRICE_ID at all, so ANY unrecognized price
 * id — a Max mismatch, a foreign product, a typo — resolved to Pro
 * entitlement. Callers MUST treat null as a refusal, never a default.
 */
export function subscriptionTierFromPriceId(
  priceId: string | null | undefined,
): SubscriptionCheckoutTier | null {
  const maxId = stripeMaxPriceId();
  const proId = stripeProPriceId();
  if (maxId && priceId === maxId) return "max";
  if (proId && priceId === proId) return "pro";
  return null;
}

export function stripeWebhookPath(): string {
  return "/api/brokerage/v1/billing/stripe/webhook";
}

export type StripeCheckoutResult = {
  /**
   * Hosted Checkout redirect. Required on the hosted path. Omitted on
   * Elements / Embedded Checkout (`ui_mode: elements|embedded_page`) —
   * those return `clientSecret` instead and must not carry a hosted URL.
   */
  checkoutUrl?: string;
  /**
   * Checkout Session client secret for Custom / Embedded Checkout.
   * Absent on the hosted path.
   */
  clientSecret?: string;
  sessionId: string;
  mode: "live" | "simulated";
  publishableKey: string | null;
  tier?: SubscriptionCheckoutTier;
  /** Smart Site ladder tier for PE user-scoped checkouts (LOCKED 2026-08-10). */
  peTier?: PeSubscriptionTier;
  /** Billing interval for PE user-scoped subscription checkouts (2026-08-24 annual ruling). */
  peInterval?: "month" | "year";
  note?: string;
};

export type StripePortalResult = {
  portalUrl: string;
  mode: "live" | "simulated";
  note?: string;
};

async function ensureWalletRow(installId: string) {
  const [existing] = await db
    .select()
    .from(brokerageWallets)
    .where(eq(brokerageWallets.installId, installId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(brokerageWallets)
    .values({ installId, balanceCents: 0, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [row] = await db
    .select()
    .from(brokerageWallets)
    .where(eq(brokerageWallets.installId, installId))
    .limit(1);
  return row!;
}

/** Exported so `pePaywallStripe.ts` can reuse the same signed HTTP call. */
export async function stripePostForm(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_SECRET_KEY!.trim();
  const body = new URLSearchParams(params);
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = (await res.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      (json.error as { message?: string } | undefined)?.message ??
        `Stripe ${path} failed (${res.status})`,
    );
  }
  return json;
}

/** Exported so `pePaywallStripe.ts` can reuse the same signed HTTP call. */
export async function stripeGet(
  path: string,
): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_SECRET_KEY!.trim();
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const json = (await res.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      (json.error as { message?: string } | undefined)?.message ??
        `Stripe ${path} failed (${res.status})`,
    );
  }
  return json;
}

async function getOrCreateStripeCustomer(installId: string): Promise<string> {
  const row = await ensureWalletRow(installId);
  if (row.stripeCustomerId) return row.stripeCustomerId;

  const customer = await stripePostForm("/customers", {
    "metadata[install_id]": installId,
    description: `Hauska Property Brief install ${installId.slice(0, 12)}`,
  });
  const customerId = String(customer.id);
  await db
    .update(brokerageWallets)
    .set({ stripeCustomerId: customerId, updatedAt: new Date() })
    .where(eq(brokerageWallets.installId, installId));
  return customerId;
}

export async function createSubscriptionCheckoutSession(input: {
  installId: string;
  tier: SubscriptionCheckoutTier;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const priceId = stripePriceIdForTier(input.tier);
  const publishableKey = stripePublishableKey();

  if (!isStripeConfigured()) {
    // Keyless dev/smoke path ONLY — no STRIPE_SECRET_KEY at all. A deployment
    // holding a real key (test or live) never lands here.
    const sessionId = `sim_cs_${input.installId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { installId: input.installId.slice(0, 8), tier: input.tier },
      "stripe: simulated checkout (no STRIPE_SECRET_KEY)",
    );
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      sessionId,
      checkoutUrl: `${input.successUrl}${sep}simulated=1&session_id=${sessionId}&tier=${input.tier}`,
      publishableKey: null,
      note: `Stripe credentials not configured — simulated ${input.tier} checkout session`,
    };
  }

  if (!priceId) {
    // FAIL CLOSED. A real Stripe key IS configured but this tier's price id
    // is not — the prior behaviour returned a fake "simulated" session here,
    // indistinguishable to the caller from a genuine one, under a key that
    // could be live. This seam served only the retired browser extension's
    // Pro/Max tiers (extension retired, not coming back — OPS-16 A-061), so
    // there is no live product this refusal could ever wrongly block; refuse
    // loudly rather than hand back a checkout session that does nothing.
    logger.error(
      { installId: input.installId.slice(0, 8), tier: input.tier },
      "stripe: checkout requested for a tier with no configured price id — refusing",
    );
    throw new BrokerageCheckoutConfigError(
      input.tier === "max" ? "STRIPE_MAX_PRICE_ID" : "STRIPE_PRO_PRICE_ID",
    );
  }

  const customerId = await getOrCreateStripeCustomer(input.installId);
  const session = await stripePostForm("/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.installId,
    "metadata[install_id]": input.installId,
    "metadata[subscription_tier]": input.tier,
    "subscription_data[metadata][install_id]": input.installId,
    "subscription_data[metadata][subscription_tier]": input.tier,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
  });

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
    tier: input.tier,
  };
}

export async function createProCheckoutSession(input: {
  installId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  return createSubscriptionCheckoutSession({ ...input, tier: "pro" });
}

/**
 * THE ONE Stripe Customer Portal call in this codebase (A-062).
 *
 * Every portal session — the install-scoped extension seam below and the PE
 * user-scoped route in `pePaywallStripe.ts` — reaches Stripe through this
 * function and nothing else. The two seams differ only in HOW THEY RESOLVE A
 * CUSTOMER, which is the part that must not be shared: the install seam may
 * create a customer for an install that has none, and the PE route must never
 * create one (A-062 acceptance item 2). Sharing the HTTP call and splitting
 * the resolution is the whole point; a second `/billing_portal/sessions`
 * poster would be a second thing to keep correct.
 *
 * `customerId` is a RESOLVED value. This function never looks one up, never
 * creates one, and never accepts an empty string — an unresolved customer is
 * the caller's refusal to make, not this function's to paper over.
 */
export async function createStripePortalSessionForCustomer(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ mode: "live"; portalUrl: string }> {
  const customerId = input.customerId.trim();
  if (!customerId) {
    // Fail closed. A blank customer id posted to Stripe is an error at best
    // and somebody else's portal at worst.
    throw new Error("Stripe portal session requires a resolved customer id");
  }
  const session = await stripePostForm("/billing_portal/sessions", {
    customer: customerId,
    return_url: input.returnUrl,
  });

  // NOT `String(session.url)`. That was the shipped shape and it could not
  // fail: `String(undefined)` is the seven-character string "undefined",
  // which is truthy, so the guard below never fired and a Stripe response
  // carrying no url redirected the customer to a page named "undefined".
  // Read the field, require it to be a non-empty string, and refuse.
  const rawUrl = session.url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("Stripe portal session missing url");
  }

  return { mode: "live", portalUrl: rawUrl };
}

export async function createBillingPortalSession(input: {
  installId: string;
  returnUrl: string;
}): Promise<StripePortalResult> {
  if (!isStripeConfigured()) {
    const sep = input.returnUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      portalUrl: `${input.returnUrl}${sep}simulated_portal=1`,
      note: "Stripe credentials not configured — simulated customer portal",
    };
  }

  const row = await ensureWalletRow(input.installId);
  const customerId =
    row.stripeCustomerId ?? (await getOrCreateStripeCustomer(input.installId));

  return createStripePortalSessionForCustomer({
    customerId,
    returnUrl: input.returnUrl,
  });
}

/** Keyless demo path — activates Pro without Stripe keys (smoke / local). */
export async function completeSimulatedCheckout(input: {
  installId: string;
  sessionId?: string;
  tier?: SubscriptionCheckoutTier;
}): Promise<void> {
  if (isStripeConfigured()) {
    throw new Error("simulated_checkout_unavailable_when_stripe_configured");
  }

  const periodEnd = new Date();
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const tier = input.tier ?? "pro";

  await setSubscriptionEntitlement({
    installId: input.installId,
    stripeCustomerId: `sim_cus_${input.installId.slice(0, 8)}`,
    stripeSubscriptionId:
      input.sessionId ?? `sim_sub_${input.installId.slice(0, 8)}`,
    subscriptionTier: tier,
    subscriptionStatus: "active",
    subscriptionPeriodEnd: periodEnd,
  });
}

export type StripeWebhookHandleResult =
  | { handled: true; eventType: string; installId?: string; peUserId?: string }
  | { handled: false; reason: string };

/** `metadata.pe_user_id` / `metadata.checkout_kind` / `metadata.subscription_tier` set by `pePaywallStripe.ts`. */
function peMetadataFromObject(obj: Record<string, unknown>): {
  peUserId: string | null;
  checkoutKind: string | null;
  parcelNodeId: string | null;
  subscriptionTierRaw: string | null;
  seatsPurchased: number | null;
} {
  const meta = obj.metadata;
  if (!meta || typeof meta !== "object") {
    return {
      peUserId: null,
      checkoutKind: null,
      parcelNodeId: null,
      subscriptionTierRaw: null,
      seatsPurchased: null,
    };
  }
  const record = meta as Record<string, unknown>;
  return {
    peUserId: typeof record.pe_user_id === "string" ? record.pe_user_id : null,
    checkoutKind:
      typeof record.checkout_kind === "string" ? record.checkout_kind : null,
    parcelNodeId:
      typeof record.parcel_node_id === "string" ? record.parcel_node_id : null,
    subscriptionTierRaw:
      typeof record.subscription_tier === "string"
        ? record.subscription_tier
        : null,
    seatsPurchased: parseMetadataSeats(record.seats_purchased),
  };
}

/**
 * Resolve the ladder tier a completed PE subscription checkout grants.
 *
 *  - `metadata.subscription_tier` valid            -> that tier
 *  - absent + legacy `checkout_kind: "pro_sub"`    -> "solo" (pre-ladder
 *    sessions carried no tier and charged the Solo-named price; never
 *    mapped to studio/team)
 *  - present but UNKNOWN value                     -> null: FAIL CLOSED,
 *    grant nothing, return unhandled so Stripe retries and the miss is
 *    visible in the webhook dashboard rather than silently granting a tier
 */
function resolvePeGrantTier(meta: {
  checkoutKind: string | null;
  subscriptionTierRaw: string | null;
}): PeSubscriptionTier | null {
  if (meta.subscriptionTierRaw !== null) {
    return isPeSubscriptionTierValue(meta.subscriptionTierRaw)
      ? meta.subscriptionTierRaw
      : null;
  }
  if (meta.checkoutKind === "pro_sub") {
    logger.warn(
      {},
      "stripe: legacy pro_sub checkout without subscription_tier — granting solo",
    );
    return "solo";
  }
  return null;
}

/**
 * Heuristic promo-vs-full-price detection for a completed Checkout Session:
 * a 100%-off (or partial) promotion code applied at checkout shows up as a
 * positive `total_details.amount_discount` on the session object the
 * webhook payload already carries — no extra Stripe API round-trip needed.
 */
function checkoutSessionHadDiscount(obj: Record<string, unknown>): boolean {
  const totalDetails = obj.total_details as
    | { amount_discount?: number }
    | undefined;
  return (
    typeof totalDetails?.amount_discount === "number" &&
    totalDetails.amount_discount > 0
  );
}

export async function handleStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): Promise<StripeWebhookHandleResult> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!isStripeConfigured()) {
    return { handled: false, reason: "stripe_not_configured" };
  }
  if (!webhookSecret) {
    return { handled: false, reason: "stripe_webhook_secret_missing" };
  }
  if (!signatureHeader) {
    return { handled: false, reason: "missing_stripe_signature" };
  }

  let event: {
    type: string;
    data: { object: Record<string, unknown> };
  };

  try {
    event = parseStripeEvent(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    logger.warn({ err }, "stripe: webhook signature verification failed");
    return { handled: false, reason: "invalid_signature" };
  }

  const type = event.type;
  const obj = event.data.object;

  if (type === "checkout.session.completed") {
    const installId = installIdFromCheckoutSession(obj);
    const subscriptionId =
      typeof obj.subscription === "string" ? obj.subscription : null;
    const customerId = typeof obj.customer === "string" ? obj.customer : null;
    const peMeta = peMetadataFromObject(obj);

    // PE property-unlock (WDLL 2026-08-05 item 4): one-time $15 checkout
    // opened by `pePaywallStripe.ts`. Writes through the SAME unlock writer
    // the operator dev-unlock route uses, with `source: "stripe"` and the
    // 30-day bound from the LOCKED 2026-08-10 ladder.
    if (peMeta.peUserId && peMeta.checkoutKind === "property_unlock") {
      if (peMeta.parcelNodeId) {
        await createPePropertyUnlock({
          ownerUserId: peMeta.peUserId,
          parcelNodeId: peMeta.parcelNodeId,
          source: "stripe",
          expiresAt: new Date(Date.now() + PE_UNLOCK_DURATION_MS),
        });
      } else {
        logger.warn(
          { peUserId: peMeta.peUserId },
          "stripe: property_unlock checkout completed with no parcel_node_id metadata",
        );
      }
      if (installId) {
        await claimInstallHistoryForUser(installId, peMeta.peUserId);
      }
      return {
        handled: true,
        eventType: "pe_property_unlock",
        installId,
        peUserId: peMeta.peUserId,
      };
    }

    // PE subscription (WDLL 2026-08-05 items 2, 5; tier-aware per the
    // LOCKED 2026-08-10 ladder): sets the PE user-scoped entitlement
    // (`pe_user_entitlements.access_tier` + `subscription_tier`), NOT the
    // install-scoped `brokerage_wallets` row the branch below writes. Promo
    // vs full-price is recorded in `entitlement_source` for the pinned
    // `/entitlement` contract's `source` field.
    if (peMeta.peUserId) {
      const grantTier = resolvePeGrantTier(peMeta);
      if (!grantTier) {
        // FAIL CLOSED: an unknown subscription_tier grants nothing. The
        // non-2xx response makes Stripe retry and surfaces the miss.
        logger.error(
          {
            peUserId: peMeta.peUserId,
            subscriptionTier: peMeta.subscriptionTierRaw,
            checkoutKind: peMeta.checkoutKind,
          },
          "stripe: PE checkout completed with unknown subscription_tier — refusing to grant",
        );
        return {
          handled: false,
          reason: `unknown_subscription_tier:${peMeta.subscriptionTierRaw ?? "absent"}`,
        };
      }
      const source = checkoutSessionHadDiscount(obj)
        ? "stripe_promo"
        : "stripe_sub";
      // P-98: the interval rides with the tier write that was already here.
      // No new write path, and both facts come from one read of the items.
      const billing = await peGrantBillingFacts({
        grantTier,
        obj,
        metadataSeats: peMeta.seatsPurchased,
        subscriptionId,
      });
      await setPeAccessTierFromStripe({
        userId: peMeta.peUserId,
        tier: "paid",
        subscriptionTier: grantTier,
        source,
        stripeCustomerId: customerId,
        seatsPurchased: billing.seatsPurchased,
        billingInterval: billing.billingInterval,
      });
      if (installId) {
        await claimInstallHistoryForUser(installId, peMeta.peUserId);
      }
      return {
        handled: true,
        eventType: "pe_subscription_active",
        installId,
        peUserId: peMeta.peUserId,
      };
    }

    if (installId) {
      const { tier, periodEnd } = await resolveSubscriptionTierFromStripe(
        subscriptionId,
        obj,
      );
      if (!tier) {
        // FAIL CLOSED: an unrecognized price id must never grant "pro" by
        // default. The non-2xx response makes Stripe retry and surfaces the
        // miss, matching the PE grant-tier refusal above.
        logger.error(
          { installId, subscriptionId },
          "stripe: legacy install-scoped checkout completed with unrecognized price id — refusing to grant",
        );
        return { handled: false, reason: "unknown_subscription_tier" };
      }

      await setSubscriptionEntitlement({
        installId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionTier: tier,
        subscriptionStatus: "active",
        subscriptionPeriodEnd: periodEnd,
      });
    }
    return { handled: true, eventType: "subscription_active", installId };
  }

  if (type === "customer.subscription.updated") {
    // PE user-scoped subscription lifecycle (subscription_data metadata set
    // by pePaywallStripe.ts): keep `pe_user_entitlements` in step so a
    // cancelled or past-due subscription actually downgrades — before the
    // 2026-08 ladder work a PE user stayed "paid" forever after one payment.
    const peMeta = peMetadataFromObject(obj);
    if (peMeta.peUserId) {
      const status = typeof obj.status === "string" ? obj.status : "";
      const active = status === "active" || status === "trialing";
      const grantTier = resolvePeGrantTier(peMeta);
      if (active && !grantTier) {
        logger.error(
          { peUserId: peMeta.peUserId, subscriptionTier: peMeta.subscriptionTierRaw },
          "stripe: PE subscription active with unknown subscription_tier — refusing to grant",
        );
        return {
          handled: false,
          reason: `unknown_subscription_tier:${peMeta.subscriptionTierRaw ?? "absent"}`,
        };
      }
      // P-98: re-derived on EVERY update, including back to null. A plan
      // change from monthly to annual is exactly this event, so carrying a
      // previous value forward when this payload does not prove it would
      // leave a stale "month" on an annual subscriber — and the rail would
      // then upsell annual billing to someone who already bought it. Same
      // rule the seat count follows: never omit the column on update.
      const billing = active
        ? await peGrantBillingFacts({
            grantTier,
            obj,
            metadataSeats: peMeta.seatsPurchased,
            subscriptionId: typeof obj.id === "string" ? obj.id : null,
          })
        : { seatsPurchased: null, billingInterval: null };
      await setPeAccessTierFromStripe({
        userId: peMeta.peUserId,
        tier: active ? "paid" : "free",
        subscriptionTier: active ? grantTier : null,
        source: "stripe_sub",
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : null,
        seatsPurchased: billing.seatsPurchased,
        billingInterval: billing.billingInterval,
      });
      return {
        handled: true,
        eventType: active ? "pe_subscription_active" : "pe_churned",
        peUserId: peMeta.peUserId,
      };
    }

    const installId = await installIdFromStripeSubscription(obj);
    const status = typeof obj.status === "string" ? obj.status : "";
    const active = status === "active" || status === "trialing";
    if (installId) {
      const subId = typeof obj.id === "string" ? obj.id : null;
      let tier: SubscriptionCheckoutTier | null = null;
      if (active) {
        tier = (await resolveSubscriptionTierFromStripe(subId, obj)).tier;
        if (!tier) {
          // FAIL CLOSED: same rule as checkout.session.completed above —
          // never default an unrecognized price id to "pro".
          logger.error(
            { installId, subscriptionId: subId },
            "stripe: legacy install-scoped subscription active with unrecognized price id — refusing to grant",
          );
          return { handled: false, reason: "unknown_subscription_tier" };
        }
      }
      await setSubscriptionEntitlement({
        installId,
        stripeCustomerId:
          typeof obj.customer === "string" ? obj.customer : null,
        stripeSubscriptionId: subId,
        subscriptionTier: active ? tier! : "free",
        subscriptionStatus: active
          ? (status as "active" | "trialing")
          : "churned",
        subscriptionPeriodEnd: periodEndFromStripe(obj),
      });
    }
    return {
      handled: true,
      eventType: active ? "subscription_active" : "churned",
      installId,
    };
  }

  if (type === "customer.subscription.deleted") {
    const peMeta = peMetadataFromObject(obj);
    if (peMeta.peUserId) {
      await setPeAccessTierFromStripe({
        userId: peMeta.peUserId,
        tier: "free",
        subscriptionTier: null,
        source: "stripe_sub",
      });
      return { handled: true, eventType: "pe_churned", peUserId: peMeta.peUserId };
    }

    const installId = await installIdFromStripeSubscription(obj);
    if (installId) {
      await setSubscriptionEntitlement({
        installId,
        subscriptionTier: "free",
        subscriptionStatus: "churned",
        subscriptionPeriodEnd: new Date(),
      });
    }
    return { handled: true, eventType: "churned", installId };
  }

  return { handled: false, reason: `ignored_event_type:${type}` };
}

function installIdFromCheckoutSession(
  obj: Record<string, unknown>,
): string | undefined {
  if (typeof obj.client_reference_id === "string" && obj.client_reference_id) {
    return obj.client_reference_id;
  }
  const meta = obj.metadata;
  if (meta && typeof meta === "object") {
    const installId = (meta as Record<string, unknown>).install_id;
    if (typeof installId === "string" && installId) return installId;
  }
  return undefined;
}

function periodEndFromStripe(obj: Record<string, unknown>): Date | null {
  const end = obj.current_period_end;
  if (typeof end === "number") return new Date(end * 1000);
  return null;
}

/**
 * The billed price items behind a PE grant, read ONCE.
 *
 * A `checkout.session.completed` payload does not carry `line_items` —
 * Stripe never expands them on a webhook — so for a brand-new subscription
 * the items have to be fetched. That fetch already existed here for Team
 * seats; P-98 widens its condition from "team only" to "any PE subscription
 * grant whose payload carries no items", because the billing interval is
 * derived from the same items and, without the widening, every new Solo and
 * Studio subscriber would store a null interval — starving the exact rung
 * (`annual_upgrade`) the column was added to feed.
 *
 * Widening cannot change the seat count: {@link resolveTeamSeatsPurchased}
 * returns null on its first line for any non-team grant, with or without
 * items. It costs at most one extra Stripe call per new subscription.
 *
 * A failed fetch returns no items, and every caller reads that as unknown.
 */
async function peBilledPriceItems(input: {
  obj: Record<string, unknown>;
  subscriptionId: string | null;
}): Promise<StripePriceItem[]> {
  const inline = extractStripePriceItems(input.obj);
  if (inline.length > 0) return inline;
  if (!input.subscriptionId || !isStripeConfigured()) return [];
  try {
    const sub = await fetchStripeSubscription(input.subscriptionId);
    return extractStripePriceItems(sub);
  } catch (err) {
    logger.warn(
      { err, subscriptionId: input.subscriptionId },
      "stripe: PE subscription items fetch failed",
    );
    return [];
  }
}

/**
 * Seat count and billing interval for a PE grant, both derived from the SAME
 * reading of the billed items so the two facts can never disagree about what
 * was on the subscription. Either may be null, and null means unknown.
 */
async function peGrantBillingFacts(input: {
  grantTier: PeSubscriptionTier | null;
  obj: Record<string, unknown>;
  metadataSeats: number | null;
  subscriptionId: string | null;
}): Promise<{
  seatsPurchased: number | null;
  billingInterval: PeBillingInterval | null;
}> {
  const items = await peBilledPriceItems({
    obj: input.obj,
    subscriptionId: input.subscriptionId,
  });
  return {
    seatsPurchased: resolveTeamSeatsPurchased({
      grantTier: input.grantTier,
      metadataSeats: input.metadataSeats,
      items,
      teamPriceIds: configuredTeamPriceIds(),
      extraSeatPriceId: configuredExtraSeatPriceId(),
    }),
    billingInterval: peBillingIntervalFromPriceItems(items),
  };
}

async function fetchStripeSubscription(
  subscriptionId: string,
): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_SECRET_KEY!.trim();
  const res = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const json = (await res.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      json.error?.message ?? `Stripe subscription fetch failed (${res.status})`,
    );
  }
  return json;
}

/** FAIL CLOSED: returns null (never a default tier) on anything unrecognized. */
function tierFromStripeObject(
  obj: Record<string, unknown>,
): SubscriptionCheckoutTier | null {
  const metaTier = (obj.metadata as Record<string, unknown> | undefined)
    ?.subscription_tier;
  if (metaTier === "max" || metaTier === "pro") return metaTier;

  const items = obj.items as { data?: unknown[] } | undefined;
  const first = items?.data?.[0] as
    | { price?: { id?: string } | string }
    | undefined;
  let priceId: string | null = null;
  if (first?.price) {
    priceId =
      typeof first.price === "string"
        ? first.price
        : typeof first.price.id === "string"
          ? first.price.id
          : null;
  }
  return subscriptionTierFromPriceId(priceId);
}

/** FAIL CLOSED: `tier: null` means unresolved — the caller must refuse, never default. */
async function resolveSubscriptionTierFromStripe(
  subscriptionId: string | null,
  obj?: Record<string, unknown>,
): Promise<{ tier: SubscriptionCheckoutTier | null; periodEnd: Date | null }> {
  let source = obj;
  if (subscriptionId) {
    try {
      source = await fetchStripeSubscription(subscriptionId);
    } catch (err) {
      logger.warn({ err, subscriptionId }, "stripe: subscription fetch failed");
    }
  }
  const tier = source ? tierFromStripeObject(source) : null;
  const periodEnd = source ? periodEndFromStripe(source) : null;
  return { tier, periodEnd };
}

async function installIdFromStripeSubscription(
  obj: Record<string, unknown>,
): Promise<string | undefined> {
  const meta = obj.metadata;
  if (meta && typeof meta === "object") {
    const installId = (meta as Record<string, unknown>).install_id;
    if (typeof installId === "string" && installId) return installId;
  }
  const subId = typeof obj.id === "string" ? obj.id : null;
  if (!subId) return undefined;

  const [row] = await db
    .select({ installId: brokerageWallets.installId })
    .from(brokerageWallets)
    .where(eq(brokerageWallets.stripeSubscriptionId, subId))
    .limit(1);
  return row?.installId;
}

/** Minimal Stripe webhook signature verification (v1). */
function parseStripeEvent(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): { type: string; data: { object: Record<string, unknown> } } {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));
  if (!tPart || v1Parts.length === 0) {
    throw new Error("invalid_stripe_signature_header");
  }
  const timestamp = tPart.slice(2);
  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const valid = v1Parts.some((p) => {
    const sig = p.slice(3);
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error("stripe_signature_mismatch");

  const parsed = JSON.parse(rawBody.toString("utf8")) as {
    type: string;
    data: { object: Record<string, unknown> };
  };
  return parsed;
}
