/**
 * P-129 -- live Stripe Subscriptions read for the signed-in PE user.
 *
 * WHY THIS EXISTS. Settings > Plan "Renewal date" reads "Not read" for every
 * account, always. `pePaywallStripe.ts`'s doc comment above
 * `peBillingIntervalForPriceId` explains why: this repo deliberately does not
 * store or read Stripe's `current_period_end` anywhere, because it "is a
 * Stripe API field whose shape moves with the API version, and nothing in
 * this repo pins a version." A renewal date needs a live, request-time call
 * to Stripe, not a stored column -- there is nowhere honest to read it from
 * otherwise.
 *
 * The cancellation flow (Settings > Plan "Cancel") redirects today to
 * Stripe's hosted Customer Portal (A-062, `PE_BILLING_PORTAL_ROUTE` in
 * `pePaywallStripe.ts`). Before sending a customer there it needs the same
 * live facts -- is a cancellation already scheduled, what date does the
 * current term end -- so the product can show what is being cancelled rather
 * than bouncing the customer into Stripe's UI blind. One route serves both.
 *
 * CUSTOMER RESOLUTION IS NOT RE-DERIVED HERE. `readPeStripeCustomerId` is the
 * exact function `createPeBillingPortalSession` (A-062) already uses to
 * resolve the signed-in PE user's Stripe customer id: read-only, and it NEVER
 * creates one. Reusing it means this route and the portal route can never
 * disagree about whose customer they are looking at, and asking "what is my
 * renewal date" -- like asking to manage billing -- must not register a
 * Stripe customer for a free user as a side effect of looking.
 *
 * THE API VERSION IS PINNED, explicitly, for this one call only. See
 * {@link STRIPE_SUBSCRIPTION_API_VERSION}. Nothing else in this repo reads
 * `current_period_end` today, so nothing else needs the pin, and
 * `stripeGet`'s other caller is unaffected (the header is additive and
 * optional).
 *
 * FAIL CLOSED, PER FIELD. Stripe's subscription object is never passed
 * through. Each field this route serves is read, type-checked, and only
 * assembled into a result when every field it needs is present and the right
 * shape -- so a future Stripe API version that renames, retypes, or removes
 * `current_period_end` (Stripe has already done exactly this once, moving
 * per-item billing-cycle fields off the top-level Subscription object for
 * multi-price subscriptions in its 2025 API versions) fails this extraction
 * closed instead of silently shipping `undefined` through `JSON.stringify`.
 */

import { isStripeConfigured, stripeGet } from "./brokerageStripe";
import { readPeStripeCustomerId } from "./pePaywallStripe";

/**
 * Pinned so `current_period_end` / `cancel_at_period_end` stay top-level
 * Subscription fields on the response this route reads. Stripe's later
 * ("acacia"/"basil" dated) API versions moved period bounds onto
 * subscription ITEMS for subscriptions whose prices bill on independent
 * cycles -- a shape this route does not need and must not acquire by
 * accident just because the Stripe account's default API version moved out
 * from under an unpinned call. Bump this deliberately, in its own change,
 * with {@link extractSubscriptionFacts} updated to match the new shape in the
 * same commit -- never let it drift with whatever the dashboard defaults to.
 */
const STRIPE_SUBSCRIPTION_API_VERSION = "2024-06-20";

/** Mounted in `propertyExplorer.ts`, named here so route and test share one string. */
export const PE_SUBSCRIPTION_ROUTE = "/property-explorer/v1/subscription";

/**
 * The only facts the renewal-date display and the cancellation flow need.
 * Deliberately NOT the raw Stripe subscription object -- see the file
 * header.
 */
export type PeSubscriptionFacts = {
  /** Stripe's subscription status string (e.g. "active", "past_due"). */
  status: string;
  /** ISO 8601, derived from Stripe's unix-seconds `current_period_end`. */
  currentPeriodEnd: string;
  /** Whether a cancellation is already scheduled to take effect at period end. */
  cancelAtPeriodEnd: boolean;
};

export type PeSubscriptionSnapshot =
  | ({ kind: "active" } & PeSubscriptionFacts)
  /**
   * DECLARED ABSENCE, not an error and not a fabricated "no renewal": no
   * Stripe customer on this account, or a customer with no subscription in a
   * currently-billing status. The ordinary state of every free account --
   * same shape discipline as `pePaywallStripe.ts`'s `PeBillingPortalResult`
   * `no-billing-account` arm.
   */
  | { kind: "no-subscription" }
  /** Stripe is not configured on this deployment. Distinct from "no-subscription" -- this means "could not check", not "checked and there is none". */
  | { kind: "not-configured" };

/**
 * Stripe statuses this route treats as "a subscription is currently in
 * force". Deliberately excludes `canceled`, `incomplete`,
 * `incomplete_expired`, and `paused` -- none of those is a live term a
 * renewal date or a scheduled-cancellation bit describes, even though
 * Stripe's own default List Subscriptions filter may still return some of
 * them. Stated here as this route's own rule rather than inherited silently
 * from whatever Stripe's default happens to be this API version.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

/**
 * Extract exactly the fields this route serves, field by field. Returns
 * `null` -- never a partial result -- if ANY field is absent or the wrong
 * type, so a Stripe response missing (or having reshaped) a field fails this
 * closed rather than shipping `undefined` through JSON to the client.
 */
function extractSubscriptionFacts(
  sub: Record<string, unknown>,
): PeSubscriptionFacts | null {
  const status = typeof sub.status === "string" ? sub.status : null;
  const periodEndRaw = sub.current_period_end;
  const cancelAtPeriodEndRaw = sub.cancel_at_period_end;
  if (!status) return null;
  if (typeof periodEndRaw !== "number" || !Number.isFinite(periodEndRaw)) {
    return null;
  }
  if (typeof cancelAtPeriodEndRaw !== "boolean") return null;
  return {
    status,
    currentPeriodEnd: new Date(periodEndRaw * 1000).toISOString(),
    cancelAtPeriodEnd: cancelAtPeriodEndRaw,
  };
}

/**
 * List this customer's subscriptions, live, at the pinned API version.
 * `status=all` is explicit rather than relying on Stripe's own default
 * status filter (documented, but a policy choice this route does not want to
 * silently inherit and have change under it) -- {@link LIVE_SUBSCRIPTION_STATUSES}
 * below is this route's own, stated rule for what counts as current.
 */
async function listStripeSubscriptionsForCustomer(
  customerId: string,
): Promise<Record<string, unknown>[]> {
  const json = await stripeGet(
    `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=10`,
    { "Stripe-Version": STRIPE_SUBSCRIPTION_API_VERSION },
  );
  const data = json.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/**
 * Read-only, live snapshot of the signed-in PE user's current Stripe
 * subscription. Never creates a Stripe customer (same rule A-062's portal
 * read follows) and never stores anything -- this is a request-time read,
 * every time, by design (the whole reason this file exists is that a stored
 * value here would drift the moment Stripe's API version moved).
 *
 * Ambiguity is refused, not guessed. This app's checkout paths
 * (`pePaywallStripe.ts`) create at most one live subscription per PE
 * customer, so more than one currently-billing subscription on the same
 * customer is a state this function does not know how to describe honestly
 * as "the" subscription -- it throws rather than silently pick whichever one
 * Stripe listed first.
 */
export async function readPeSubscriptionSnapshot(
  userId: string,
): Promise<PeSubscriptionSnapshot> {
  if (!isStripeConfigured()) {
    return { kind: "not-configured" };
  }

  // READ, never get-or-create -- see the file header.
  const customerId = await readPeStripeCustomerId(userId);
  if (!customerId) {
    return { kind: "no-subscription" };
  }

  const subs = await listStripeSubscriptionsForCustomer(customerId);
  const live = subs.filter((s) => {
    const status = typeof s.status === "string" ? s.status : "";
    return LIVE_SUBSCRIPTION_STATUSES.has(status);
  });

  if (live.length === 0) {
    return { kind: "no-subscription" };
  }
  if (live.length > 1) {
    // FAIL CLOSED: a fabricated "the" subscription is worse than an honest
    // refusal here -- a customer in this state needs a human to look, not a
    // guessed renewal date.
    throw new Error(
      `stripe customer ${customerId} carries ${live.length} concurrent live subscriptions -- refusing to guess which is "the" subscription`,
    );
  }

  const facts = extractSubscriptionFacts(live[0]);
  if (!facts) {
    throw new Error(
      "stripe subscription response missing or misshapen status/current_period_end/cancel_at_period_end",
    );
  }
  return { kind: "active", ...facts };
}
