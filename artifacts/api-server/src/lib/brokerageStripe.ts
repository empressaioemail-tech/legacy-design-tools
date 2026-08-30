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
import { db, brokerageWallets, type PeSubscriptionTier } from "@workspace/db";
import { logger } from "./logger";
import { setSubscriptionEntitlement } from "./brokerageEntitlement";
import { createPePropertyUnlock } from "./peEntitlement";
import { setPeAccessTierFromStripe } from "./peIdentity";
import { claimInstallHistoryForUser } from "./brokerageInstallClaim";
import {
  configuredExtraSeatPriceId,
  configuredTeamPriceIds,
  extractStripePriceItems,
  parseMetadataSeats,
  resolveTeamSeatsPurchased,
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

function stripePriceIdForTier(tier: SubscriptionCheckoutTier): string | null {
  return tier === "max" ? stripeMaxPriceId() : stripeProPriceId();
}

export function subscriptionTierFromPriceId(
  priceId: string | null | undefined,
): SubscriptionCheckoutTier {
  const maxId = stripeMaxPriceId();
  if (maxId && priceId === maxId) return "max";
  return "pro";
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

  if (!isStripeConfigured() || !priceId) {
    const sessionId = `sim_cs_${input.installId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { installId: input.installId.slice(0, 8), tier: input.tier },
      "stripe: simulated checkout (no STRIPE_SECRET_KEY or price id)",
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

  const session = await stripePostForm("/billing_portal/sessions", {
    customer: customerId,
    return_url: input.returnUrl,
  });

  const portalUrl = String(session.url);
  if (!portalUrl) throw new Error("Stripe portal session missing url");

  return { mode: "live", portalUrl };
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
      await setPeAccessTierFromStripe({
        userId: peMeta.peUserId,
        tier: "paid",
        subscriptionTier: grantTier,
        source,
        stripeCustomerId: customerId,
        seatsPurchased: await seatsPurchasedForPeGrant({
          grantTier,
          obj,
          metadataSeats: peMeta.seatsPurchased,
          subscriptionId,
        }),
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
      await setPeAccessTierFromStripe({
        userId: peMeta.peUserId,
        tier: active ? "paid" : "free",
        subscriptionTier: active ? grantTier : null,
        source: "stripe_sub",
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : null,
        seatsPurchased: active
          ? await seatsPurchasedForPeGrant({
              grantTier,
              obj,
              metadataSeats: peMeta.seatsPurchased,
              subscriptionId: typeof obj.id === "string" ? obj.id : null,
            })
          : null,
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
      const { tier } = active
        ? await resolveSubscriptionTierFromStripe(subId, obj)
        : { tier: "pro" as const };
      await setSubscriptionEntitlement({
        installId,
        stripeCustomerId:
          typeof obj.customer === "string" ? obj.customer : null,
        stripeSubscriptionId: subId,
        subscriptionTier: active ? tier : "free",
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

async function seatsPurchasedForPeGrant(input: {
  grantTier: PeSubscriptionTier | null;
  obj: Record<string, unknown>;
  metadataSeats: number | null;
  subscriptionId: string | null;
}): Promise<number | null> {
  let items = extractStripePriceItems(input.obj);
  if (
    input.grantTier === "team" &&
    items.length === 0 &&
    input.subscriptionId &&
    isStripeConfigured()
  ) {
    try {
      const sub = await fetchStripeSubscription(input.subscriptionId);
      items = extractStripePriceItems(sub);
    } catch (err) {
      logger.warn(
        { err, subscriptionId: input.subscriptionId },
        "stripe: team seats subscription fetch failed",
      );
    }
  }
  return resolveTeamSeatsPurchased({
    grantTier: input.grantTier,
    metadataSeats: input.metadataSeats,
    items,
    teamPriceIds: configuredTeamPriceIds(),
    extraSeatPriceId: configuredExtraSeatPriceId(),
  });
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

function tierFromStripeObject(
  obj: Record<string, unknown>,
): SubscriptionCheckoutTier {
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

async function resolveSubscriptionTierFromStripe(
  subscriptionId: string | null,
  obj?: Record<string, unknown>,
): Promise<{ tier: SubscriptionCheckoutTier; periodEnd: Date | null }> {
  let source = obj;
  if (subscriptionId) {
    try {
      source = await fetchStripeSubscription(subscriptionId);
    } catch (err) {
      logger.warn({ err, subscriptionId }, "stripe: subscription fetch failed");
    }
  }
  const tier = source ? tierFromStripeObject(source) : "pro";
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
