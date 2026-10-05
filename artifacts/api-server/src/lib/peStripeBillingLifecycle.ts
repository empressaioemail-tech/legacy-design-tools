/**
 * P-494 — Stripe subscription billing lifecycle rules (pure, replay-testable).
 *
 * Contract v3: `_inbox/2026-10-03_ghl_to_resend_PLAN_integration_end.md` section 4.
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
 * `customer.subscription.updated`: emit `ss.plan_started` only on tier/price/
 * interval change or first activation (`incomplete` → active/trialing). Never
 * on renewal-only period moves or `past_due` → `active` recovery.
 */
export function peSubscriptionUpdatedShouldEmitPlanStarted(input: {
  previousAttributes: Record<string, unknown> | undefined;
  currentStatus: string;
}): boolean {
  const prev = input.previousAttributes;
  if (!prev || Object.keys(prev).length === 0) return false;

  if ("items" in prev || "plan" in prev) return true;

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

/**
 * Which end-of-plan Resend event to emit when entitlement drops to free.
 * Never both; non-payment (`payment_failed`) is `ss.plan_ended_unpaid` only.
 */
export function peSubscriptionEndLifecycleEvent(
  obj: Record<string, unknown>,
): PeSubscriptionEndEvent {
  if (stripeCancellationIsPaymentFailure(obj)) {
    return "plan_ended_unpaid";
  }
  return "plan_cancelled";
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
