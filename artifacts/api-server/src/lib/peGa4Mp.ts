/**
 * GA4 Measurement Protocol — server-side `purchase` from the Stripe webhook.
 *
 * WHY SERVER-SIDE: the charged amount is only known for certain here (promo
 * codes, seats, annual vs monthly), and the browser's success landing may
 * never load. The GA4 `client_id` (and `session_id` when present) captured
 * from the visitor's `_ga` / `_ga_<stream>` cookies at checkout creation ties
 * the purchase to their web session, which is what lets Google Ads import it.
 *
 * OFF UNLESS CONFIGURED: needs GA4_MEASUREMENT_ID and GA4_API_SECRET. No id is
 * compiled in; absent config is a named refusal. A purchase with no captured
 * client id is refused by name too (GA4 MP requires one, and inventing one
 * would create a fake user).
 *
 * THE PRIVACY LINE: params are value, currency, transaction_id (the Stripe
 * Checkout Session id) and a plan label. page_location is the generic site
 * URL. The exact wire body is walked by the shared leak detector first.
 */

import { adMatchFromPayload, type AdMatch } from "./peAdMatch";
import type { OutboxRecord } from "./peLifecycleOutbox";
import { createHash } from "node:crypto";
import { findAnalyticsLeaks, peGenericEventSourceUrl } from "./peAnalyticsSanitizer";

export const GA4_MP_ENDPOINT = "https://www.google-analytics.com/mp/collect";

export type Ga4MpConfig = { measurementId: string; apiSecret: string };

export function ga4MpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Ga4MpConfig | { refused: string } {
  const measurementId = env["GA4_MEASUREMENT_ID"]?.trim().toUpperCase();
  const apiSecret = env["GA4_API_SECRET"]?.trim();
  if (!measurementId || !/^G-[A-Z0-9]{4,20}$/.test(measurementId)) {
    return { refused: "ga4_measurement_id_absent" };
  }
  if (!apiSecret) return { refused: "ga4_api_secret_absent" };
  return { measurementId, apiSecret };
}

export type Ga4PurchaseInput = {
  transactionId: string;
  value: number;
  currency: string;
  /** "unlock" | "solo" | "studio" | "team" — a product, never a parcel. */
  plan: string;
  adMatch: AdMatch;
  /** SHA-256 hex of the internal user id; optional GA4 user_id. */
  hashedUserId?: string | null;
  timestampMicros?: number;
};

export function buildGa4PurchaseBody(input: Ga4PurchaseInput): Record<string, unknown> | null {
  const clientId = input.adMatch.gaClientId;
  if (!clientId) return null;
  const params: Record<string, unknown> = {
    transaction_id: input.transactionId,
    value: input.value,
    currency: input.currency,
    page_location: peGenericEventSourceUrl(),
    items: [
      {
        item_id: `smartsite_${input.plan}`,
        item_name: `Smart Site ${input.plan}`,
        price: input.value,
        quantity: 1,
      },
    ],
  };
  if (input.adMatch.gaSessionId) params["session_id"] = input.adMatch.gaSessionId;
  // engagement_time_msec makes GA4 count the hit as an engaged session hit.
  params["engagement_time_msec"] = 1;
  return {
    client_id: clientId,
    ...(input.hashedUserId ? { user_id: input.hashedUserId } : {}),
    ...(input.timestampMicros ? { timestamp_micros: input.timestampMicros } : {}),
    events: [{ name: "purchase", params }],
  };
}

export type Ga4MpResult = { ok: true } | { ok: false; error: string };

export async function sendGa4Purchase(
  input: Ga4PurchaseInput,
  opts: { fetchImpl?: typeof fetch; config?: Ga4MpConfig | { refused: string } } = {},
): Promise<Ga4MpResult> {
  const config = opts.config ?? ga4MpConfigFromEnv();
  if ("refused" in config) return { ok: false, error: config.refused };
  if (!Number.isFinite(input.value)) return { ok: false, error: "ga4_purchase_value_unknown" };
  const body = buildGa4PurchaseBody(input);
  if (!body) return { ok: false, error: "ga4_client_id_absent" };
  if (findAnalyticsLeaks(body).length > 0) return { ok: false, error: "ga4_identifier_leak_refused" };
  const url = `${GA4_MP_ENDPOINT}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    // MP answers 2xx for anything it parsed; it does not validate content.
    if (!res.ok) return { ok: false, error: `ga4_mp_http_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "ga4_mp_failed" };
  }
}

/** GA4 purchase input for one outbox row, or null when the row is not a purchase. */
export function ga4PurchaseInputFromOutboxRow(row: OutboxRecord): Ga4PurchaseInput | null {
  if (row.eventType !== "e4_unlock_bought" && row.eventType !== "e5_plan_started") return null;
  const value = row.payload["value"];
  const transactionId = row.payload["transactionId"];
  const currency = row.payload["currency"];
  const plan = row.payload["plan"];
  const userId = row.subject.kind === "user" ? row.subject.userId : null;
  return {
    transactionId: typeof transactionId === "string" && transactionId ? transactionId : row.id,
    value: typeof value === "number" ? value : Number.NaN,
    currency: typeof currency === "string" ? currency : "USD",
    plan: typeof plan === "string" ? plan : "unknown",
    adMatch: adMatchFromPayload(row.payload),
    hashedUserId: userId ? createHash("sha256").update(userId.trim()).digest("hex") : null,
  };
}
