#!/usr/bin/env node
/**
 * Smoke — Stripe billing checkout (simulated or live test mode).
 *
 * Usage:
 *   BROKERAGE_EXTENSION_PUBLIC_KEY=... node scripts/_stripe-billing-smoke.mjs [baseUrl]
 *
 * Simulated (no Stripe secrets): checkout -> complete-simulated -> entitlement proActive
 * Live test mode: prints checkout URL for manual 4242 completion + webhook note
 */
const BASE =
  process.argv[2]?.trim() ||
  "https://canary---cortex-api-tds7av26va-uc.a.run.app";
const KEY = process.env.BROKERAGE_EXTENSION_PUBLIC_KEY?.trim();
if (!KEY) {
  console.error("BROKERAGE_EXTENSION_PUBLIC_KEY required");
  process.exit(1);
}

const INSTALL = `cc-agent-C-stripe-smoke-${Date.now()}`;
const headers = {
  "X-Hauska-Key": KEY,
  "X-Hauska-Install-Id": INSTALL,
  "Content-Type": "application/json",
};

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, raw: text };
}

async function main() {
  console.log("BASE", BASE);
  console.log("INSTALL", INSTALL);

  const checkout = await jsonFetch(`${BASE}/api/brokerage/v1/billing/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      successUrl: "https://extension.example/billing/success",
      cancelUrl: "https://extension.example/billing/cancel",
    }),
  });
  console.log("\n===== POST /billing/checkout =====");
  console.log("HTTP", checkout.status);
  console.log(JSON.stringify(checkout.body, null, 2));
  if (checkout.status !== 200) throw new Error("checkout failed");

  if (checkout.body.mode === "simulated") {
    console.log("\n===== POST /billing/checkout/complete-simulated =====");
    const complete = await jsonFetch(
      `${BASE}/api/brokerage/v1/billing/checkout/complete-simulated`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: checkout.body.sessionId }),
      },
    );
    console.log("HTTP", complete.status);
    console.log(JSON.stringify(complete.body, null, 2));
    if (complete.status !== 200 || !complete.body.proActive) {
      throw new Error("simulated complete failed");
    }
  } else {
    console.log(
      "\nLIVE TEST MODE: open checkoutUrl in browser, pay with card 4242424242424242.",
    );
    console.log(
      "Webhook must deliver checkout.session.completed to:",
      `${BASE.replace("canary---", "").replace("https://", "https://")}/api/brokerage/v1/billing/stripe/webhook`,
    );
    console.log("Then re-run GET /entitlement for this install id.");
    return;
  }

  const ent = await jsonFetch(`${BASE}/api/brokerage/v1/entitlement`, {
    headers: { "X-Hauska-Key": KEY, "X-Hauska-Install-Id": INSTALL },
  });
  console.log("\n===== GET /entitlement =====");
  console.log("HTTP", ent.status);
  console.log(JSON.stringify(ent.body, null, 2));
  if (!ent.body.proActive) throw new Error("proActive not true after checkout");

  const portal = await jsonFetch(`${BASE}/api/brokerage/v1/billing/portal`, {
    method: "POST",
    headers,
    body: JSON.stringify({ returnUrl: "https://extension.example/settings" }),
  });
  console.log("\n===== POST /billing/portal =====");
  console.log("HTTP", portal.status);
  console.log(JSON.stringify(portal.body, null, 2));

  console.log("\n===== PASS =====");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
