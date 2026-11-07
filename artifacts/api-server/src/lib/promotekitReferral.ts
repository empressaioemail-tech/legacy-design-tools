/**
 * PromoteKit affiliate referral — OPS-16 P-185.
 *
 * The id PromoteKit's tag captured from a `?via=<affiliate>` visit
 * (`window.promotekit_referral`, read at checkout time by hauska-map
 * `billingClient.ts`), echoed onto the Stripe Checkout Session so PromoteKit
 * can attribute the sale from Stripe itself. It is an opaque PUBLIC token, not
 * a secret, and NOT trusted input.
 *
 * This module exists on its own — with no database or Stripe import — so the
 * rule has exactly ONE implementation and a DB-free test (`promotekit-referral
 * .test.ts`) that can run on a workstation with no local Postgres. The two
 * checkout session builders in `pePaywallStripe.ts` call
 * {@link applyPromotekitReferral}; nothing else writes these form keys.
 *
 * LENIENT-TO-IGNORE, NEVER STRICT-TO-REJECT: an id that does not look like one
 * is DROPPED (the metadata key is simply absent), never turned into a 400,
 * because a malformed attribution token must never block a customer's
 * purchase. A dropped id means the session is created exactly as it would have
 * been without a referral — the sale attributes to no affiliate, which is the
 * honest outcome, and the absent key is the evidence of the drop.
 */

/** Form-body keys Stripe Checkout reads. One spelling, both builders. */
export const PROMOTEKIT_REFERRAL_METADATA_KEY =
  "metadata[promotekit_referral]";
export const PROMOTEKIT_REFERRAL_SUBSCRIPTION_METADATA_KEY =
  "subscription_data[metadata][promotekit_referral]";

/** Long enough for any real token, short enough to be obviously not a payload. */
export const PE_PROMOTEKIT_REFERRAL_MAX_LENGTH = 128;

/** The id, trimmed, or `null` when it does not look like one. Never throws. */
export function normalizePromotekitReferral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > PE_PROMOTEKIT_REFERRAL_MAX_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Write the referral onto a Checkout Session form body.
 *
 * `subscription: true` (the recurring path) ALSO writes the
 * `subscription_data` copy, so renewals attribute — a session-only referral
 * attributes the first payment and nothing after it.
 *
 * Returns whether a key was written, so a caller can log a drop without
 * re-deriving the rule.
 */
export function applyPromotekitReferral(
  params: Record<string, string>,
  referral: unknown,
  opts: { subscription?: boolean } = {},
): boolean {
  const normalized = normalizePromotekitReferral(referral);
  if (!normalized) return false;
  params[PROMOTEKIT_REFERRAL_METADATA_KEY] = normalized;
  if (opts.subscription) {
    params[PROMOTEKIT_REFERRAL_SUBSCRIPTION_METADATA_KEY] = normalized;
  }
  return true;
}
