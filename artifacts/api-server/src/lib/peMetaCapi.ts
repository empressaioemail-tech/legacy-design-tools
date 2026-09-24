/**
 * Meta Conversions API sender for Smart Site lifecycle events.
 *
 * Hashed email only. No personal data in custom parameters. If the access
 * token is absent, refuse by name and record the refusal — never send with
 * a placeholder (P-413 / A-253).
 */

import { createHash } from "node:crypto";
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
};

export type MetaCapiConfig = {
  pixelId: string;
  accessToken: string;
};

export type MetaCapiResult =
  | { ok: true; eventName: string }
  | { ok: false; error: string };

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
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
  return { pixelId, accessToken };
}

export function metaEventName(event: LifecycleEventType): string | null {
  return EVENT_NAMES[event];
}

export async function sendMetaCapiEvent(
  input: {
    event: LifecycleEventType;
    eventId: string;
    email: string;
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
        user_data: { em: [hashEmail(input.email)] },
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
  };
  assertLifecyclePayloadSafe(payload);

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
