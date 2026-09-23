/**
 * Public cortex-api URLs for Stripe checkout return pages (reachable origin).
 *
 * D-25 (OPS-25, 2026-09-23). THIS BASE URL HAS NO DEFAULT. The function used to
 * end `return "<retired Google Cloud Run cortex-api host>"`, so a deployment
 * that never set `BROKERAGE_BILLING_PUBLIC_BASE_URL` handed Stripe a return URL
 * on a host that no longer resolves, and the customer paid and then landed
 * nowhere. Deleted rather than repointed: a default aimed at the replacement
 * host is the same defect at the next move. The literal is not retyped here,
 * deliberately, so a repo-wide grep for the dead host stays clean.
 *
 * It THROWS rather than returning a plausible-looking origin, and both routes
 * that call this handle it as a declared 503 -- see `brokerageBilling.ts` and
 * `propertyExplorerBilling.ts`. A wrong-but-well-formed return URL is the one
 * outcome that must not be reachable: the failure would surface on Stripe's
 * side, after the charge.
 */

/** Thrown when `BROKERAGE_BILLING_PUBLIC_BASE_URL` is unset. Named so a route can refuse by name. */
export class BillingPublicBaseUrlUnsetError extends Error {
  readonly refusal = "billing_public_base_url_unset";

  constructor() {
    super(
      "BROKERAGE_BILLING_PUBLIC_BASE_URL is not set, so there is no reachable origin to " +
        "return a Stripe checkout to. There is no default origin (D-25): the retired " +
        "Google Cloud host is dead and must not be used.",
    );
    this.name = "BillingPublicBaseUrlUnsetError";
  }
}

export function brokerageBillingPublicBaseUrl(): string {
  const raw = process.env.BROKERAGE_BILLING_PUBLIC_BASE_URL?.trim();
  if (!raw) throw new BillingPublicBaseUrlUnsetError();
  return raw.replace(/\/+$/, "");
}

export function defaultCheckoutSuccessUrl(): string {
  return `${brokerageBillingPublicBaseUrl()}/api/brokerage/v1/billing/checkout-complete`;
}

export function defaultCheckoutCancelUrl(): string {
  return `${brokerageBillingPublicBaseUrl()}/api/brokerage/v1/billing/checkout-cancel`;
}
