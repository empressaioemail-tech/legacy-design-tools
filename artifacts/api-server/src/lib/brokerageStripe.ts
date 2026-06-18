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
import { db, brokerageWallets } from "@workspace/db";
import { logger } from "./logger";
import { setSubscriptionEntitlement } from "./brokerageEntitlement";

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
  checkoutUrl: string;
  sessionId: string;
  mode: "live" | "simulated";
  publishableKey: string | null;
  tier?: SubscriptionCheckoutTier;
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

async function stripePostForm(
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
  | { handled: true; eventType: string; installId?: string }
  | { handled: false; reason: string };

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
