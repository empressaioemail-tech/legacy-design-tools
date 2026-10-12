/**
 * Meta Conversions API sender for Smart Site lifecycle events.
 *
 * user_data (2026-10-12, Events Manager: EMQ 3.2/10, "server isn't sending
 * any user_data parameter keys"): every server event now carries, when known,
 *   em           SHA-256 of the trimmed, lowercased email      (hashed)
 *   external_id  SHA-256 of the internal user id               (hashed)
 *   client_ip_address / client_user_agent / fbp / fbc         (NOT hashed,
 *                per Meta's spec) captured from the visitor's own browser
 *                request at sign-in or at checkout creation (peAdMatch.ts)
 * plus `event_source_url` (the generic site URL, never a page address), which
 * Meta requires for action_source "website".
 *
 * No personal data in custom parameters. If the access token is absent,
 * refuse by name and record the refusal — never send with a placeholder
 * (P-413 / A-253). A payload that would carry a parcel identifier is refused
 * by name too (peAnalyticsSanitizer.ts), never sent.
 */

import { createHash } from "node:crypto";
import { adMatchFromPayload, type AdMatch } from "./peAdMatch";
import type { OutboxRecord } from "./peLifecycleOutbox";
import { findAnalyticsLeaks, peGenericEventSourceUrl } from "./peAnalyticsSanitizer";
import { assertLifecyclePayloadSafe } from "./peLifecycleDenylist";
import type { LifecycleEventType } from "./peLifecycleTypes";

export const META_CAPI_ENDPOINT = "https://graph.facebook.com/v21.0";

const EVENT_NAMES: Record<LifecycleEventType, string | null> = {
  e1_account_created: "CompleteRegistration",
  e2_lot_saved: "LotSaved",
  e3_share_sent: "ShareSent",
  e4_unlock_bought: "Purchase",
  e5_plan_started: "Purchase",
  e6_last_active: null,
  became_sharer: null,
  plan_cancelled: null,
  payment_failed: null,
  plan_ended_unpaid: null,
  claude_connected: null,
  went_quiet: null,
  came_back: null,
  affiliate_applied: null,
  affiliate_approved: null,
};

/** Refusals that name a missing configuration; recorded on the leg, not retried as a send. */
export const META_REFUSED_BY_NAME = [
  "meta_event_not_applicable",
  "meta_capi_token_absent",
  "meta_pixel_id_absent",
  "meta_capi_token_placeholder",
  "meta_identifier_leak_refused",
] as const;

export type MetaCapiConfig = {
  pixelId: string;
  accessToken: string;
  /** Events Manager → Test Events code. Set only on a preview/test deploy. */
  testEventCode?: string;
};

export type MetaCapiResult =
  | { ok: true; eventName: string }
  | { ok: false; error: string };

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** external_id: SHA-256 of the internal user id (trimmed, case preserved). */
export function hashExternalId(userId: string): string {
  return createHash("sha256").update(userId.trim()).digest("hex");
}

export type MetaServerUserData = {
  em: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
};

/** Built from named fields only; a caller cannot spread an extra identity key in. */
export function buildMetaUserData(input: {
  email: string;
  userId?: string | null;
  adMatch?: AdMatch | null;
}): MetaServerUserData {
  const ud: MetaServerUserData = { em: [hashEmail(input.email)] };
  if (input.userId && input.userId.trim()) ud.external_id = [hashExternalId(input.userId)];
  const m = input.adMatch ?? {};
  if (m.clientIp) ud.client_ip_address = m.clientIp;
  if (m.clientUserAgent) ud.client_user_agent = m.clientUserAgent;
  if (m.fbp) ud.fbp = m.fbp;
  if (m.fbc) ud.fbc = m.fbc;
  return ud;
}

export function metaCapiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MetaCapiConfig | { refused: string } {
  const pixelId = env["META_PIXEL_ID"]?.trim();
  const accessToken = env["META_CAPI_ACCESS_TOKEN"]?.trim();
  if (!pixelId) return { refused: "meta_pixel_id_absent" };
  if (!accessToken) return { refused: "meta_capi_token_absent" };
  if (accessToken === "placeholder" || accessToken === "YOUR_TOKEN") {
    return { refused: "meta_capi_token_placeholder" };
  }
  const testEventCode = env["META_TEST_EVENT_CODE"]?.trim();
  return { pixelId, accessToken, ...(testEventCode ? { testEventCode } : {}) };
}

export function metaEventName(event: LifecycleEventType): string | null {
  return EVENT_NAMES[event];
}

export async function sendMetaCapiEvent(
  input: {
    event: LifecycleEventType;
    eventId: string;
    email: string;
    /** Internal user id; sent only as its SHA-256 (`external_id`). */
    userId?: string | null;
    /** Visitor match keys captured at sign-in / checkout creation. */
    adMatch?: AdMatch | null;
    eventTime?: number;
    value?: number;
    currency?: string;
  },
  opts: {
    fetchImpl?: typeof fetch;
    config?: MetaCapiConfig | { refused: string };
  } = {},
): Promise<MetaCapiResult> {
  const eventName = metaEventName(input.event);
  if (!eventName) return { ok: false, error: "meta_event_not_applicable" };

  const config = opts.config ?? metaCapiConfigFromEnv();
  if ("refused" in config) {
    return { ok: false, error: config.refused };
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: input.eventId,
        action_source: "website",
        event_source_url: peGenericEventSourceUrl(),
        user_data: buildMetaUserData({
          email: input.email,
          userId: input.userId ?? null,
          adMatch: input.adMatch ?? null,
        }),
        ...(input.value !== undefined
          ? {
              custom_data: {
                value: input.value,
                currency: input.currency ?? "USD",
              },
            }
          : {}),
      },
    ],
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };
  assertLifecyclePayloadSafe(payload);
  // THE PRIVACY LINE: final walk over the exact wire object.
  if (findAnalyticsLeaks(payload).length > 0) {
    return { ok: false, error: "meta_identifier_leak_refused" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${META_CAPI_ENDPOINT}/${encodeURIComponent(config.pixelId)}/events?access_token=${encodeURIComponent(config.accessToken)}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, error: `meta_capi_http_${res.status}` };
    }
    return { ok: true, eventName };
  } catch (err) {
    const message = err instanceof Error ? err.message : "meta_capi_failed";
    return { ok: false, error: message };
  }
}

/**
 * The Meta leg's input for one outbox row. Pure: what the Stripe webhook and
 * the sign-in path wrote onto the row is exactly what reaches Meta.
 */
export function metaCapiInputFromOutboxRow(row: OutboxRecord, now: Date) {
  const value = row.payload["value"];
  const currency = row.payload["currency"];
  return {
    event: row.eventType,
    eventId: row.id,
    email: row.email,
    userId: row.subject.kind === "user" ? row.subject.userId : null,
    adMatch: adMatchFromPayload(row.payload),
    eventTime: Math.floor(now.getTime() / 1000),
    value: typeof value === "number" ? value : undefined,
    currency: typeof currency === "string" ? currency : undefined,
  };
}
