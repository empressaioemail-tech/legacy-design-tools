import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AD_MATCH_HEADERS,
  AD_MATCH_STRIPE_METADATA,
  adMatchFromHeaders,
  adMatchFromPayload,
  adMatchFromStripeMetadata,
  adMatchToPayload,
  adMatchToStripeParams,
  normalizeAdMatch,
} from "./peAdMatch";
import { findAnalyticsLeaks, peGenericEventSourceUrl } from "./peAnalyticsSanitizer";
import { buildGa4PurchaseBody, ga4PurchaseInputFromOutboxRow, sendGa4Purchase } from "./peGa4Mp";
import { assertEnqueuePayloadAllowed } from "./peLifecycleDenylist";
import { enqueueLifecycleEvent, memoryOutboxStore } from "./peLifecycleOutbox";
import {
  buildMetaUserData,
  hashEmail,
  hashExternalId,
  metaCapiConfigFromEnv,
  metaCapiInputFromOutboxRow,
  sendMetaCapiEvent,
} from "./peMetaCapi";
import { stripeLifecycleApply, subscriptionItemsAmount } from "./peStripeBillingLifecycle";

/**
 * 2026-10-12 Events Manager: server events carried no usable user_data
 * (EMQ 3.2/10); CompleteRegistration thin; Purchase quiet. These pin what
 * cortex now sends for CompleteRegistration (sign-in) and Purchase (the
 * Stripe webhook), and that no parcel identifier reaches Meta or Google.
 */

const USER_ID = "b3f1c7a0-0000-4000-8000-000000000001";
const EMAIL = "  Buyer@Example.COM ";
const PARCEL = "48453:107190";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
const MATCH = {
  clientIp: "203.0.113.9",
  clientUserAgent: UA,
  fbp: "fb.1.1712000000000.1234567890",
  fbc: "fb.1.1712000000001.IwAR2realclick",
  gaClientId: "1234567890.1712000000",
  gaSessionId: "1712000123",
};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function captureFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("user_data: hashing exactly per Meta spec", () => {
  it("em and external_id are SHA-256; ip, ua, fbp, fbc are not hashed", () => {
    expect(buildMetaUserData({ email: EMAIL, userId: USER_ID, adMatch: MATCH })).toEqual({
      em: [sha("buyer@example.com")],
      external_id: [sha(USER_ID)],
      client_ip_address: MATCH.clientIp,
      client_user_agent: UA,
      fbp: MATCH.fbp,
      fbc: MATCH.fbc,
    });
    expect(hashEmail(EMAIL)).toBe(sha("buyer@example.com"));
    expect(hashExternalId(USER_ID)).toBe(sha(USER_ID));
  });

  it("carries event_source_url (generic) and test_event_code when configured", async () => {
    const { calls, fetchImpl } = captureFetch();
    const r = await sendMetaCapiEvent(
      { event: "e1_account_created", eventId: "evt-cr", email: EMAIL, userId: USER_ID, adMatch: MATCH },
      { fetchImpl, config: { pixelId: "px", accessToken: "tok", testEventCode: "TEST999" } },
    );
    expect(r).toEqual({ ok: true, eventName: "CompleteRegistration" });
    const body = calls[0]!.body as { data: Array<Record<string, unknown>>; test_event_code?: string };
    expect(body.test_event_code).toBe("TEST999");
    expect(body.data[0]!["event_source_url"]).toBe("https://smartsite.cloud/");
    expect(body.data[0]!["event_id"]).toBe("evt-cr");
    expect(findAnalyticsLeaks(body)).toEqual([]);
  });

  it("reads META_TEST_EVENT_CODE from env, absent by default", () => {
    expect(metaCapiConfigFromEnv({ META_PIXEL_ID: "px", META_CAPI_ACCESS_TOKEN: "tok" })).toEqual({
      pixelId: "px",
      accessToken: "tok",
    });
    expect(
      metaCapiConfigFromEnv({ META_PIXEL_ID: "px", META_CAPI_ACCESS_TOKEN: "tok", META_TEST_EVENT_CODE: "T1" }),
    ).toEqual({ pixelId: "px", accessToken: "tok", testEventCode: "T1" });
  });

  it("generic event_source_url honours PE_SITE_ORIGIN and nothing else", () => {
    expect(peGenericEventSourceUrl({ PE_SITE_ORIGIN: "https://smartsite.cloud/" })).toBe("https://smartsite.cloud/");
    expect(peGenericEventSourceUrl({ PE_SITE_ORIGIN: "https://x.test/?parcel=1" })).toBe("https://smartsite.cloud/");
    expect(peGenericEventSourceUrl({})).toBe("https://smartsite.cloud/");
  });
});

describe("ad match keys: checkout creation -> Stripe metadata -> outbox payload", () => {
  it("reads the BFF headers, with NO fallback to the proxy's own ip/ua", () => {
    const headers: Record<string, string> = {
      [AD_MATCH_HEADERS.clientIp]: MATCH.clientIp,
      [AD_MATCH_HEADERS.clientUserAgent]: UA,
      [AD_MATCH_HEADERS.fbp]: MATCH.fbp,
      [AD_MATCH_HEADERS.fbc]: MATCH.fbc,
      [AD_MATCH_HEADERS.gaClientId]: MATCH.gaClientId,
      [AD_MATCH_HEADERS.gaSessionId]: MATCH.gaSessionId,
      "user-agent": "node",
    };
    expect(adMatchFromHeaders({ header: (n) => headers[n.toLowerCase()] })).toEqual(MATCH);
    expect(adMatchFromHeaders({ header: (n) => (n === "user-agent" ? "node" : undefined) })).toEqual({});
  });

  it("drops malformed values rather than forwarding them", () => {
    expect(
      normalizeAdMatch({ clientIp: "unknown", fbp: "not-a-cookie", gaClientId: "abc", clientUserAgent: "" }),
    ).toEqual({});
  });

  it("Stripe metadata keys fit Stripe's limits and round-trip", () => {
    const params = adMatchToStripeParams(MATCH);
    for (const [k, v] of Object.entries(params)) {
      const key = k.slice("metadata[".length, -1);
      expect(key.length).toBeLessThanOrEqual(40);
      expect(v.length).toBeLessThanOrEqual(500);
    }
    const metadata = Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k.slice("metadata[".length, -1), v]),
    );
    expect(adMatchFromStripeMetadata(metadata)).toEqual(MATCH);
    expect(Object.keys(metadata).sort()).toEqual(Object.values(AD_MATCH_STRIPE_METADATA).sort());
  });

  it("outbox payload keys pass the enqueue allowlist and round-trip", () => {
    const payload = { email: "a@b.co", event: "e4_unlock_bought", ...adMatchToPayload(MATCH) };
    expect(() => assertEnqueuePayloadAllowed(payload)).not.toThrow();
    expect(adMatchFromPayload(payload)).toEqual(MATCH);
  });
});

/** A `checkout.session.completed` object as Stripe sends it for the $15 unlock. */
const UNLOCK_SESSION = {
  id: "cs_live_a1B2c3",
  object: "checkout.session",
  amount_total: 1500,
  currency: "usd",
  mode: "payment",
  metadata: {
    pe_user_id: USER_ID,
    checkout_kind: "property_unlock",
    parcel_node_id: PARCEL,
    ...Object.fromEntries(
      Object.entries(adMatchToStripeParams(MATCH)).map(([k, v]) => [k.slice("metadata[".length, -1), v]),
    ),
  },
};

describe("webhook Purchase payload construction (checkout.session.completed)", () => {
  it("unlock: Purchase reaches Meta with value, currency, full user_data, no parcel", async () => {
    // What brokerageStripe.ts does with the session object:
    const apply = stripeLifecycleApply({
      email: EMAIL.trim(),
      event: "e4_unlock_bought",
      plan: "unlock",
      billing: "none",
      value: UNLOCK_SESSION.amount_total / 100,
      currency: UNLOCK_SESSION.currency.toUpperCase(),
      adMatch: adMatchFromStripeMetadata(UNLOCK_SESSION.metadata),
      transactionId: UNLOCK_SESSION.id,
    });
    const store = memoryOutboxStore();
    const { eventId } = await enqueueLifecycleEvent(
      { userId: USER_ID, email: EMAIL.trim(), event: "e4_unlock_bought", idempotencyKey: "e4:evt_1", apply },
      store,
    );
    const row = store.rows.find((r) => r.id === eventId)!;
    // The parcel the unlock is FOR never left the Stripe metadata.
    expect(JSON.stringify(row.payload)).not.toContain(PARCEL);

    const { calls, fetchImpl } = captureFetch();
    const r = await sendMetaCapiEvent(metaCapiInputFromOutboxRow(row, new Date(1_760_000_000_000)), {
      fetchImpl,
      config: { pixelId: "px", accessToken: "tok" },
    });
    expect(r).toEqual({ ok: true, eventName: "Purchase" });
    const wire = calls[0]!.body as { data: Array<Record<string, unknown>> };
    const ev = wire.data[0]!;
    expect(ev["event_name"]).toBe("Purchase");
    expect(ev["event_id"]).toBe(eventId);
    expect(ev["action_source"]).toBe("website");
    expect(ev["event_source_url"]).toBe("https://smartsite.cloud/");
    expect(ev["custom_data"]).toEqual({ value: 15, currency: "USD" });
    expect(ev["user_data"]).toEqual({
      em: [sha("buyer@example.com")],
      external_id: [sha(USER_ID)],
      client_ip_address: MATCH.clientIp,
      client_user_agent: UA,
      fbp: MATCH.fbp,
      fbc: MATCH.fbc,
    });
    expect(JSON.stringify(wire)).not.toContain(PARCEL);
    expect(JSON.stringify(wire)).not.toContain("107190");
    expect(findAnalyticsLeaks(wire)).toEqual([]);

    // GA4 purchase from the same row.
    const ga = captureFetch();
    const gaInput = ga4PurchaseInputFromOutboxRow(row)!;
    const g = await sendGa4Purchase(gaInput, {
      fetchImpl: ga.fetchImpl,
      config: { measurementId: "G-TEST123", apiSecret: "secret" },
    });
    expect(g).toEqual({ ok: true });
    const gaBody = ga.calls[0]!.body as { client_id: string; events: Array<{ name: string; params: Record<string, unknown> }> };
    expect(gaBody.client_id).toBe(MATCH.gaClientId);
    expect(gaBody.events[0]!.name).toBe("purchase");
    expect(gaBody.events[0]!.params).toMatchObject({
      transaction_id: "cs_live_a1B2c3",
      value: 15,
      currency: "USD",
      session_id: MATCH.gaSessionId,
      page_location: "https://smartsite.cloud/",
    });
    expect(JSON.stringify(gaBody)).not.toContain("107190");
    expect(findAnalyticsLeaks(gaBody)).toEqual([]);
  });

  it("plan activated by customer.subscription.updated: value comes from the items", () => {
    expect(
      subscriptionItemsAmount({
        object: "subscription",
        items: {
          data: [
            { price: { unit_amount: 9900 }, quantity: 1 },
            { price: { unit_amount: 2500 }, quantity: 2 },
          ],
        },
      }),
    ).toBe(149);
    expect(subscriptionItemsAmount({ items: { data: [{ price: { unit_amount: null } }] } })).toBeUndefined();
    expect(subscriptionItemsAmount({})).toBeUndefined();
  });

  for (const plan of ["solo", "studio", "team"] as const) {
    it(`${plan} subscription checkout: Purchase payload carries value and the match keys`, async () => {
      const apply = stripeLifecycleApply({
        email: "p@example.com",
        event: "e5_plan_started",
        plan,
        billing: "monthly",
        value: 99,
        currency: "USD",
        adMatch: MATCH,
        transactionId: "cs_live_plan",
      });
      const store = memoryOutboxStore();
      const { eventId } = await enqueueLifecycleEvent(
        { userId: USER_ID, email: "p@example.com", event: "e5_plan_started", idempotencyKey: `e5:${plan}`, apply },
        store,
      );
      const row = store.rows.find((r) => r.id === eventId)!;
      const { calls, fetchImpl } = captureFetch();
      await sendMetaCapiEvent(metaCapiInputFromOutboxRow(row, new Date()), {
        fetchImpl,
        config: { pixelId: "px", accessToken: "tok" },
      });
      const ev = (calls[0]!.body as { data: Array<Record<string, unknown>> }).data[0]!;
      expect(ev["event_name"]).toBe("Purchase");
      expect(ev["custom_data"]).toEqual({ value: 99, currency: "USD" });
      expect((ev["user_data"] as Record<string, unknown>)["client_ip_address"]).toBe(MATCH.clientIp);
      expect(ga4PurchaseInputFromOutboxRow(row)!.plan).toBe(plan);
    });
  }

  it("GA4 refuses by name when unconfigured or when no client id was captured", async () => {
    const input = { transactionId: "cs_1", value: 15, currency: "USD", plan: "unlock", adMatch: {} };
    expect(await sendGa4Purchase(input, { config: { refused: "ga4_measurement_id_absent" } })).toEqual({
      ok: false,
      error: "ga4_measurement_id_absent",
    });
    expect(
      await sendGa4Purchase(input, { config: { measurementId: "G-TEST123", apiSecret: "s" } }),
    ).toEqual({ ok: false, error: "ga4_client_id_absent" });
    expect(buildGa4PurchaseBody(input)).toBeNull();
  });

  it("a payload that would carry a parcel identifier is refused by name, never sent", async () => {
    const { calls, fetchImpl } = captureFetch();
    const r = await sendMetaCapiEvent(
      {
        event: "e4_unlock_bought",
        eventId: "x",
        email: "a@b.co",
        adMatch: { fbp: `fb.1.1712000000000.${PARCEL}` },
        value: 15,
      },
      { fetchImpl, config: { pixelId: "px", accessToken: "tok" } },
    );
    expect(r).toEqual({ ok: false, error: "meta_identifier_leak_refused" });
    expect(calls).toHaveLength(0);
  });
});

/** Mirrored from hauska-map api/_lib/analytics-sanitizer.test.ts. */
const LEAKY_VALUES = [
  PARCEL,
  "48021:34137.00000000",
  `viewed ${PARCEL} today`,
  "48453%3A107190",
  "coord:30.26715,-97.74306",
  "coord:30.26715:-97.74306",
  "30.267153, -97.743061",
  "https://smartsite.cloud/?parcelNodeId=abc",
  "https://smartsite.cloud/?address=x",
  "https://smartsite.cloud/s/8f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  "https://smartsite.cloud/share?g=8f3a1c2e",
  "https://smartsite.cloud/share#tok",
];

describe("findAnalyticsLeaks (cortex mirror) can fail", () => {
  for (const value of LEAKY_VALUES) {
    it(`flags ${value}`, () => {
      expect(findAnalyticsLeaks({ data: [{ custom_data: { k: value } }] }).length).toBeGreaterThan(0);
    });
  }
  it("flags identifying keys outside user_data, not Meta's own user_data keys", () => {
    expect(findAnalyticsLeaks({ custom_data: { parcel_node_id: "x" } }).length).toBeGreaterThan(0);
    expect(
      findAnalyticsLeaks({ user_data: { client_ip_address: "2600:1700:abcd::1", client_user_agent: UA } }),
    ).toEqual([]);
  });
});
