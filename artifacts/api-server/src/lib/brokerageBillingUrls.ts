/** Public cortex-api URLs for Stripe checkout return pages (reachable origin). */

export function brokerageBillingPublicBaseUrl(): string {
  const raw = process.env.BROKERAGE_BILLING_PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return "https://cortex-api-tds7av26va-uc.a.run.app";
}

export function defaultCheckoutSuccessUrl(): string {
  return `${brokerageBillingPublicBaseUrl()}/api/brokerage/v1/billing/checkout-complete`;
}

export function defaultCheckoutCancelUrl(): string {
  return `${brokerageBillingPublicBaseUrl()}/api/brokerage/v1/billing/checkout-cancel`;
}
