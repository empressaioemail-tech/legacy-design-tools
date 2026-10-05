/**
 * Recorded Stripe webhook shapes (account API 2026-05-27.dahlia).
 * Period bounds on subscription items; invoice.subscription often absent.
 */

/** Live Studio monthly renewal 2026-10-04T15:22Z — same price/qty/interval; period end moved. */
export const DAHLIA_STUDIO_MONTHLY_RENEWAL = {
  previousAttributes: {
    items: {
      data: [
        {
          id: "si_renewal_prev",
          quantity: 1,
          current_period_end: 1767225600,
          price: {
            id: "price_1QStudio12900c1UgO",
            unit_amount: 12900,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: "in_prev_cycle",
  },
  currentSubscription: {
    id: "sub_studio_live",
    status: "active",
    items: {
      data: [
        {
          id: "si_renewal_prev",
          quantity: 1,
          current_period_end: 1769904000,
          price: {
            id: "price_1QStudio12900c1UgO",
            unit_amount: 12900,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
  },
} as const;

export const DAHLIA_SOLO_TO_STUDIO_TIER_CHANGE = {
  previousAttributes: {
    items: {
      data: [
        {
          id: "si_tier",
          quantity: 1,
          price: {
            id: "price_solo_month",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  },
  currentSubscription: {
    id: "sub_tier_change",
    status: "active",
    items: {
      data: [
        {
          id: "si_tier",
          quantity: 1,
          price: {
            id: "price_studio_month",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  },
} as const;

export const DAHLIA_TEAM_SEAT_QUANTITY_ONLY = {
  previousAttributes: {
    items: {
      data: [
        {
          id: "si_team_base",
          quantity: 1,
          price: {
            id: "price_team_base",
            recurring: { interval: "month" },
          },
        },
        {
          id: "si_team_seat",
          quantity: 2,
          price: {
            id: "price_team_seat",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  },
  currentSubscription: {
    id: "sub_team_seats",
    status: "active",
    items: {
      data: [
        {
          id: "si_team_base",
          quantity: 1,
          price: {
            id: "price_team_base",
            recurring: { interval: "month" },
          },
        },
        {
          id: "si_team_seat",
          quantity: 4,
          price: {
            id: "price_team_seat",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  },
} as const;

export const DAHLIA_INVOICE_PAYMENT_FAILED = {
  invoice: {
    id: "in_dahlia_fail_1",
    billing_reason: "subscription_cycle",
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: "sub_past_due_1",
      },
    },
  },
  subscription: {
    id: "sub_past_due_1",
    status: "past_due",
    metadata: { pe_user_id: "user-pe-1", subscription_tier: "solo" },
  },
} as const;
