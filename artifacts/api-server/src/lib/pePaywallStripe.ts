/**
 * Property Explorer user-authenticated Stripe checkout (WDLL 2026-08-05
 * items 2, 3). Distinct from `brokerageStripe.ts`'s install-scoped
 * extension checkout: these sessions are keyed on the signed-in PE
 * `pe_user_id`, carry `metadata.checkout_kind` so the shared webhook
 * handler in `brokerageStripe.ts` can route them, and support Stripe's
 * built-in promotion-code UI on the subscription path.
 *
 * Secret Manager names (shared with brokerageStripe.ts):
 *   STRIPE_SECRET_KEY
 *   STRIPE_PUBLISHABLE_KEY
 *   STRIPE_PRO_PRICE_ID
 *   STRIPE_PE_UNLOCK_PRICE_ID   (new — $15 one-time property unlock price)
 */

import { eq } from "drizzle-orm";
import { db, peUserEntitlements } from "@workspace/db";
import { logger } from "./logger";
import {
  isStripeConfigured,
  stripePostForm,
  stripePublishableKey,
  stripeProPriceId,
  type StripeCheckoutResult,
} from "./brokerageStripe";
import { setPeStripeCustomerId } from "./peIdentity";

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

export type PeCheckoutKind = "pro_sub" | "property_unlock";

/**
 * $/month Pro subscription checkout for a signed-in PE user. Carries
 * `metadata.pe_user_id` (webhook routes off this) and
 * `allow_promotion_codes: true` so a tester can apply a 100%-off promo code
 * at the real Stripe Checkout UI and land in the same paid path as a full
 * payment (WDLL acceptance item 2).
 */
export async function createPeSubscriptionCheckoutSession(input: {
  userId: string;
  email?: string | null;
  installId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const priceId = stripeProPriceId();
  const publishableKey = stripePublishableKey();

  if (!isStripeConfigured() || !priceId) {
    const sessionId = `sim_cs_${input.userId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { userId: input.userId.slice(0, 8) },
      "pe-stripe: simulated pro checkout (no STRIPE_SECRET_KEY or price id)",
    );
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      sessionId,
      checkoutUrl: `${input.successUrl}${sep}simulated=1&session_id=${sessionId}&tier=pro`,
      publishableKey: null,
      tier: "pro",
      note: "Stripe credentials not configured — simulated PE Pro checkout",
    };
  }

  const customerId = await getOrCreatePeStripeCustomer(input);
  const params: Record<string, string> = {
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: "true",
    "metadata[pe_user_id]": input.userId,
    "metadata[checkout_kind]": "pro_sub" satisfies PeCheckoutKind,
    "subscription_data[metadata][pe_user_id]": input.userId,
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
  return { mode: "live", sessionId, checkoutUrl, publishableKey, tier: "pro" };
}

/**
 * $15 one-time per-property unlock checkout for a signed-in PE user. On
 * completion the shared webhook writes a `pe_property_unlocks` row via
 * `createPePropertyUnlock({ source: "stripe" })` — this function only opens
 * the Checkout Session.
 */
export async function createPePropertyUnlockCheckoutSession(input: {
  userId: string;
  email?: string | null;
  parcelNodeId: string;
  installId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutResult> {
  const priceId = stripePeUnlockPriceId();
  const publishableKey = stripePublishableKey();

  if (!isStripeConfigured() || !priceId) {
    const sessionId = `sim_cs_unlock_${input.userId.slice(0, 8)}_${Date.now()}`;
    logger.info(
      { userId: input.userId.slice(0, 8), parcelNodeId: input.parcelNodeId },
      "pe-stripe: simulated property-unlock checkout (no STRIPE_SECRET_KEY or STRIPE_PE_UNLOCK_PRICE_ID)",
    );
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      mode: "simulated",
      sessionId,
      checkoutUrl: `${input.successUrl}${sep}simulated=1&session_id=${sessionId}&unlock=1`,
      publishableKey: null,
      note:
        "Stripe credentials or STRIPE_PE_UNLOCK_PRICE_ID not configured — simulated unlock checkout",
    };
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
