/**
 * P-494 replay tests on recorded Stripe payload shapes.
 */

import { describe, expect, it } from "vitest";
import {
  invoicePaymentFailedShouldEmit,
  peStatusRetainsPaidEntitlement,
  peSubscriptionEndLifecycleEvent,
  peSubscriptionUpdatedShouldEmitPlanStarted,
  planStartedIdempotencyKey,
} from "./peStripeBillingLifecycle";

describe("peStatusRetainsPaidEntitlement", () => {
  it("keeps paid access for past_due", () => {
    expect(peStatusRetainsPaidEntitlement("past_due")).toBe(true);
  });

  it("does not retain for unpaid", () => {
    expect(peStatusRetainsPaidEntitlement("unpaid")).toBe(false);
  });
});

describe("subscription.updated lifecycle emits", () => {
  it("monthly renewal (period only) emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: {
          current_period_start: 1700000000,
          current_period_end: 1702678400,
        },
        currentStatus: "active",
      }),
    ).toBe(false);
  });

  it("annual renewal (period only) emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: {
          current_period_start: 1700000000,
          current_period_end: 1731536000,
        },
        currentStatus: "active",
      }),
    ).toBe(false);
  });

  it("tier change (items) emits plan_started", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: {
          items: {
            data: [{ price: { id: "price_solo" } }],
          },
        },
        currentStatus: "active",
      }),
    ).toBe(true);
  });

  it("past_due update emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "active" },
        currentStatus: "past_due",
      }),
    ).toBe(false);
  });

  it("past_due back to active emits nothing", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "past_due" },
        currentStatus: "active",
      }),
    ).toBe(false);
  });

  it("first activation incomplete to active emits plan_started", () => {
    expect(
      peSubscriptionUpdatedShouldEmitPlanStarted({
        previousAttributes: { status: "incomplete" },
        currentStatus: "active",
      }),
    ).toBe(true);
  });
});

describe("subscription end events", () => {
  it("deleted for non-payment emits only plan_ended_unpaid", () => {
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

describe("invoice.payment_failed", () => {
  it("renewal failure while past_due emits once", () => {
    expect(
      invoicePaymentFailedShouldEmit({
        invoice: {
          id: "in_1",
          billing_reason: "subscription_cycle",
          subscription: "sub_1",
        },
        subscriptionStatus: "past_due",
      }),
    ).toBe(true);
  });

  it("replay of same invoice id uses stable idempotency key", () => {
    const key = planStartedIdempotencyKey({
      stripeEventId: "evt_a",
      subscriptionId: "sub_1",
      activation: true,
    });
    expect(key).toBe("e5:sub_activate:sub_1");
    expect(key).toBe(
      planStartedIdempotencyKey({
        stripeEventId: "evt_b",
        subscriptionId: "sub_1",
        activation: true,
      }),
    );
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
