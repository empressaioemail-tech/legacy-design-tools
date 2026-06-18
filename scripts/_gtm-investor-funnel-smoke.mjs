#!/usr/bin/env node
/** Smoke investor GTM funnel on cortex-api canary. */
const CANARY =
  process.env.CORTEX_CANARY_URL?.trim() ||
  "https://canary---cortex-api-tds7av26va-uc.a.run.app";

const API_KEY = process.env.BROKERAGE_OPERATOR_API_KEY?.trim();
if (!API_KEY) {
  console.error("BROKERAGE_OPERATOR_API_KEY required");
  process.exit(1);
}

const INSTALL_ID = `smoke-funnel-${Date.now()}`;
const EVENT_TYPES = [
  "radar_autorun",
  "deal_kept",
  "deal_passed",
  "session_return",
  "paywall_hit",
  "upgrade_started",
  "subscription_active",
  "churned",
];

async function api(path, init = {}) {
  const res = await fetch(`${CANARY}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log(`Canary: ${CANARY}`);
  console.log(`Install: ${INSTALL_ID}`);

  const consent = await api("/api/brokerage/v1/gtm/consent", {
    method: "POST",
    body: JSON.stringify({
      installId: INSTALL_ID,
      consentVersion: "2026-05-26-v1",
      graphOptIn: false,
    }),
  });
  console.log("consent", consent.status, consent.body?.ok);

  for (const eventType of EVENT_TYPES) {
    const ev = await api("/api/brokerage/v1/gtm/events", {
      method: "POST",
      body: JSON.stringify({
        installId: INSTALL_ID,
        eventType,
        payload: { smoke: true, intentScore: eventType === "paywall_hit" ? 80 : 50 },
      }),
    });
    console.log(`event ${eventType}`, ev.status, ev.body?.eventId ? "ok" : ev.body);
    if (ev.status !== 201) process.exit(1);
  }

  const digest = await api("/api/brokerage/v1/gtm/digest?windowDays=1");
  console.log("digest", digest.status);
  if (digest.status !== 200) {
    console.error(digest.body);
    process.exit(1);
  }

  const funnel = digest.body.investorFunnel;
  if (!funnel?.funnel) {
    console.error("missing investorFunnel readout", digest.body);
    process.exit(1);
  }

  const recorded = new Set(
    funnel.funnel
      .filter((s) => s.count > 0)
      .map((s) => s.eventType),
  );
  console.log("investorFunnel upgrades", funnel.upgrades);
  console.log("recorded event types with count>0:", [...recorded].sort().join(", "));

  for (const t of EVENT_TYPES) {
    if (!recorded.has(t)) {
      console.error(`expected ${t} in digest funnel counts`);
      process.exit(1);
    }
  }

  console.log("PASS — all 8 funnel event types recorded; investorFunnel readout OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
