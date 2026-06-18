#!/usr/bin/env node
/**
 * Operator helper — create Stripe TEST mode Product + recurring Price for Hauska Pro.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/_stripe-setup-pro-price.mjs
 *
 * Prints the price id to store as Secret Manager secret STRIPE_PRO_PRICE_ID.
 */
const secret = process.env.STRIPE_SECRET_KEY?.trim();
if (!secret) {
  console.error("STRIPE_SECRET_KEY required (sk_test_...)");
  process.exit(1);
}

async function stripePost(path, params) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Stripe ${path} failed (${res.status})`);
  }
  return json;
}

async function main() {
  const product = await stripePost("/products", {
    name: "Hauska Pro",
    description: "Unlimited Property Briefs and full underwriting depth",
    "metadata[hauska_tier]": "pro",
  });

  const price = await stripePost("/prices", {
    product: product.id,
    currency: "usd",
    "recurring[interval]": "month",
    unit_amount: "2900",
    nickname: "Hauska Pro monthly (test)",
  });

  console.log(JSON.stringify({ productId: product.id, priceId: price.id }, null, 2));
  console.log("\nSet Secret Manager secret STRIPE_PRO_PRICE_ID to:", price.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
