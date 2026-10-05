/**
 * P-494 — Stripe subscription billing lifecycle rules (pure, replay-testable).
 *
 * Contract v3: `_inbox/2026-10-03_ghl_to_resend_PLAN_integration_end.md` section 4.
 * Stripe account API: 2026-05-27.dahlia (period fields on items; invoice.parent).
 */

import type { LifecycleEventType } from "./peLifecycleTypes";

/** Paid access while Stripe retries; never downgrade or emit on `past_due` alone. */
export function peStatusRetainsPaidEntitlement(status: string): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export function stripeCancellationIsPaymentFailure(
  obj: Record<string, unknown>,
): boolean {
  const details = obj.cancellation_details;
  if (!details || typeof details !== "object") return false;
  const reason = (details as Record<string, unknown>).reason;
  return reason === "payment_failed";
}

/**
 * Price id + recurring interval per line item (ignores quantity and period fields).
 * Sorted multiset for stable comparison.
 */
export function subscriptionItemPriceIntervalSignatures(
  itemsContainer: unknown,
): string[] {
  if (!itemsContainer || typeof itemsContainer !== "object") return [];
  const data = (itemsContainer as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const sigs: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const price = r.price;
    const plan = r.plan;
    let priceId: string | null = null;
    let interval: string | null = null;
    if (price && typeof price === "object") {
      const p = price as Record<string, unknown>;
      priceId = typeof p.id === "string" ? p.id : null;
      const rec = p.recurring;
      if (rec && typeof rec === "object") {
        const iv = (rec as Record<string, unknown>).interval;
        interval = typeof iv === "string" ? iv : null;
      }
    } else if (plan && typeof plan === "object") {
      const pl = plan as Record<string, unknown>;
      priceId = typeof pl.id === "string" ? pl.id : null;
      interval = typeof pl.interval === "string" ? pl.interval : null;
    }
    if (!priceId) continue;
    sigs.push(interval ? `${priceId}:${interval}` : priceId);
  }
  sigs.sort();
  return sigs;
}

function legacyPlanSignature(plan: unknown): string[] {
  if (!plan || typeof plan !== "object") return [];
  const p = plan as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id : null;
  const interval = typeof p.interval === "string" ? p.interval : null;
  if (!id) return [];
  return [interval ? `${id}:${interval}` : id];
}

/**
 * True when billed price id or recurring interval changed. False when only
 * quantity or billing-period fields moved (renewals on dahlia include `items`
 * in previous_attributes).
 */
export function subscriptionPriceIntervalChanged(input: {
  previousAttributes: Record<string, unknown> | undefined;
  currentSubscription: Record<string, unknown>;
}): boolean | null {
  const prev = input.previousAttributes;
  if (!prev) return null;

  if (prev.items !== undefined) {
    const prevSig = subscriptionItemPriceIntervalSignatures(prev.items);
    const curSig = subscriptionItemPriceIntervalSignatures(
      input.currentSubscription.items,
    );
    if (prevSig.length === 0 || curSig.length === 0) return null;
    return JSON.stringify(prevSig) !== JSON.stringify(curSig);
  }

  if (prev.plan !== undefined) {
    const prevSig = legacyPlanSignature(prev.plan);
    const curSig = subscriptionItemPriceIntervalSignatures(
      input.currentSubscription.items,
    );
    if (prevSig.length === 0 || curSig.length === 0) return null;
    return JSON.stringify(prevSig) !== JSON.stringify(curSig);
  }

  return null;
}

/**
 * `customer.subscription.updated`: emit `ss.plan_started` only on tier/price/
 * interval change or first activation (`incomplete` → active/trialing). Never
 * on renewal-only period moves, seat-quantity-only changes, or `past_due`
 * recovery.
 */
export function peSubscriptionUpdatedShouldEmitPlanStarted(input: {
  previousAttributes: Record<string, unknown> | undefined;
  currentStatus: string;
  currentSubscription: Record<string, unknown>;
}): boolean {
  const prev = input.previousAttributes;
  if (!prev || Object.keys(prev).length === 0) return false;

  const prevStatus = typeof prev.status === "string" ? prev.status : null;
  if (
    prevStatus === "incomplete" &&
    (input.currentStatus === "active" || input.currentStatus === "trialing")
  ) {
    return true;
  }

  if (prevStatus === "past_due" && input.currentStatus === "active") {
    return false;
  }

  if ("items" in prev || "plan" in prev) {
    const changed = subscriptionPriceIntervalChanged({
      previousAttributes: prev,
      currentSubscription: input.currentSubscription,
    });
    return changed === true;
  }

  const keys = Object.keys(prev);
  const renewalOnly = keys.every(
    (k) =>
      k === "current_period_start" ||
      k === "current_period_end" ||
      k === "latest_invoice" ||
      k === "billing_cycle_anchor",
  );
  if (renewalOnly) return false;

  return false;
}

export type PeSubscriptionEndEvent =
  | "plan_ended_unpaid"
  | "plan_cancelled"
  | null;

export function peSubscriptionEndLifecycleEvent(
  obj: Record<string, unknown>,
): PeSubscriptionEndEvent {
  if (stripeCancellationIsPaymentFailure(obj)) {
    return "plan_ended_unpaid";
  }
  return "plan_cancelled";
}

/** Dahlia: subscription id on invoice.parent.subscription_details.subscription. */
export function stripeSubscriptionIdFromInvoice(
  invoice: Record<string, unknown>,
): string | null {
  const top = invoice.subscription;
  if (typeof top === "string" && top.trim()) return top.trim();
  const parent = invoice.parent;
  if (parent && typeof parent === "object") {
    const details = (parent as Record<string, unknown>).subscription_details;
    if (details && typeof details === "object") {
      const sub = (details as Record<string, unknown>).subscription;
      if (typeof sub === "string" && sub.trim()) return sub.trim();
    }
  }
  return null;
}

export function invoicePaymentFailedShouldEmit(input: {
  invoice: Record<string, unknown>;
  subscriptionStatus: string | null;
}): boolean {
  const reason = input.invoice.billing_reason;
  if (reason !== "subscription_cycle") return false;
  return input.subscriptionStatus === "past_due";
}

export function planStartedIdempotencyKey(input: {
  stripeEventId: string;
  subscriptionId: string | null;
  activation: boolean;
}): string {
  if (input.activation && input.subscriptionId) {
    return `e5:sub_activate:${input.subscriptionId}`;
  }
  return `e5:${input.stripeEventId}`;
}

export function isPaidPlanLifecycleEvent(
  event: LifecycleEventType,
): boolean {
  return (
    event === "e4_unlock_bought" ||
    event === "e5_plan_started" ||
    event === "plan_cancelled" ||
    event === "payment_failed" ||
    event === "plan_ended_unpaid"
  );
}
