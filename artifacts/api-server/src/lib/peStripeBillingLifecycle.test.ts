/**
 * P-494 replay tests — Stripe 2026-05-27.dahlia shapes (fixtures fail on
 * pre-fix logic that treated any `items` key in previous_attributes as a plan start).
 */

import { describe, expect, it } from "vitest";
import {
  DAHLIA_INVOICE_PAYMENT_FAILED,
  DAHLIA_SOLO_TO_STUDIO_TIER_CHANGE,
  DAHLIA_STUDIO_MONTHLY_RENEWAL,
  DAHLIA_TEAM_SEAT_QUANTITY_ONLY,
} from "./peStripeBillingLifecycle.fixtures";
import {
  invoicePaymentFailedShouldEmit,
  peStatusRetainsPaidEntitlement,
  peSubscriptionEndLifecycleEvent,
  peSubscriptionUpdatedShouldEmitPlanStarted,
  planStartedIdempotencyKey,
  stripeSubscriptionIdFromInvoice,
  subscriptionPriceIntervalChanged,
} from "./peStripeBillingLifecycle";

describe("peStatusRetainsPaidEntitlement", () => {
  it("keeps paid access for past_due", () => {
    expect(peStatusRetainsPaidEntitlement("past_due")).toBe(true);
  });

  it("does not retain for unpaid", () => {
    expect(peStatusRetainsPaidEntitlement("unpaid")).toBe(false);
  });
});

describe("subscription.updated (dahlia replay fixtures)", () => {
  it("live Studio monthly renewal — items in previous_attributes, same price/interval — no plan_started", () => {
    const f = DAHLIA_STUDIO_MONTHLY_RENEWAL;
    expect(
      subscriptionPriceIntervalChanged({
        previousAttributes: f.previousAttributes,
        currentSubscription: f.currentSubscription,
      }),
    ).toBe(false);
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: f.previousAttributes,
        currentStatus: "active",
        currentSubscription: f.currentSubscription,
      }),
    ).toBe(false);
  });

  it("tier change (price id) emits plan_started", () => {
    const f = DAHLIA_SOLO_TO_STUDIO_TIER_CHANGE;
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: f.previousAttributes,
        currentStatus: "active",
        currentSubscription: f.currentSubscription,
      }),
    ).toBe(true);
  });

  it("Team extra-seat quantity only — not a plan start", () => {
    const f = DAHLIA_TEAM_SEAT_QUANTITY_ONLY;
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: f.previousAttributes,
        currentStatus: "active",
        currentSubscription: f.currentSubscription,
      }),
    ).toBe(false);
  });

  it("annual renewal (legacy top-level period keys only) emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: {
          current_period_start: 1700000000,
          current_period_end: 1731536000,
        },
        currentStatus: "active",
        currentSubscription: { id: "sub_x", status: "active", items: { data: [] } },
      }),
    ).toBe(false);
  });

  it("past_due transition emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "active" },
        currentStatus: "past_due",
        currentSubscription: { id: "sub_x", status: "past_due" },
      }),
    ).toBe(false);
  });

  it("past_due back to active emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "past_due" },
        currentStatus: "active",
        currentSubscription: { id: "sub_x", status: "active" },
      }),
    ).toBe(false);
  });

  it("first activation incomplete to active emits plan_started", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "incomplete" },
        currentStatus: "active",
        currentSubscription: { id: "sub_new", status: "active" },
      }),
    ).toBe(true);
  });
});

describe("subscription end events", () => {
  it("non-payment end emits plan_ended_unpaid", () => {
    expect(
      peSubscriptionEndLifecycleEvent({
        status: "canceled",
        cancellation_details: { reason: "payment_failed" },
      }),
    ).toBe("plan_ended_unpaid");
  });

  it("customer cancel emits plan_cancelled", () => {
    expect(
      peSubscriptionEndLifecycleEvent({
        status: "canceled",
        cancellation_details: { reason: "cancellation_requested" },
      }),
    ).toBe("plan_cancelled");
  });
});

describe("invoice.payment_failed (dahlia)", () => {
  it("reads subscription id from parent.subscription_details", () => {
    const { invoice } = DAHLIA_INVOICE_PAYMENT_FAILED;
    expect(stripeSubscriptionIdFromInvoice(invoice)).toBe("sub_past_due_1");
    expect(invoice.subscription).toBeUndefined();
  });

  it("falls back to top-level invoice.subscription", () => {
    expect(
      stripeSubscriptionIdFromInvoice({
        subscription: "sub_legacy",
        parent: {
          subscription_details: { subscription: "sub_dahlia" },
        },
      }),
    ).toBe("sub_legacy");
  });

  it("renewal failure while past_due emits", () => {
    expect(
      invoicePaymentFailedShouldEmit({
        invoice: DAHLIA_INVOICE_PAYMENT_FAILED.invoice,
        subscriptionStatus: "past_due",
      }),
    ).toBe(true);
  });

  it("activation idempotency is per subscription id", () => {
    expect(
      planStartedIdempotencyKey({
        stripeEventId: "evt_a",
        subscriptionId: "sub_1",
        activation: true,
      }),
    ).toBe("e5:sub_activate:sub_1");
  });

  it("non-cycle invoice does not emit", () => {
    expect(
      invoicePaymentFailedShouldEmit({
        invoice: { billing_reason: "subscription_create" },
        subscriptionStatus: "past_due",
      }),
    ).toBe(false);
  });
});
