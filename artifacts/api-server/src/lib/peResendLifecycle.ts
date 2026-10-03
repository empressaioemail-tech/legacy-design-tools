/**
 * The outbox's `resend` leg (P-492, plan section 3c): put the contact in its
 * segment with the contract v2 properties, then send the contract v2 event.
 *
 * Request shapes, read from Resend's live API reference on 2026-10-03 and
 * recorded in the lane's CP1 (`_inbox/2026-10-03_p492-lifecycle-resend_cp1.json`):
 *   PATCH /contacts/{email}                     {first_name?, properties}
 *   POST  /contacts                             {email, first_name?, properties, segments:[{id}]}
 *   POST  /contacts/{email}/segments/{segment}
 *   POST  /events/send                          {event, email, payload?}
 *
 * Uses `RESEND_API_KEY` (already on cortex for sign-in and records mail). The
 * segment ids have NO default and NO fallback: unset refuses by name, and the
 * outbox records the refusal on the leg, where it is retried and counted.
 *
 * The Resend API rate limit is 10 requests per second PER TEAM, shared with
 * the magic-link sender. This leg paces its own calls (min interval per
 * process) so lifecycle traffic cannot 429 a sign-in link.
 *
 * Never throws; every failure is a `{ ok: false, error }`.
 */

import { assertLifecyclePayloadSafe } from "./peLifecycleDenylist";

export const RESEND_API_BASE = "https://api.resend.com";
export const RESEND_REQUEST_TIMEOUT_MS = 8000;
export const RESEND_MIN_INTERVAL_MS = 400;

type FetchLike = typeof fetch;

export type ResendLifecycleConfig = {
  apiKey: string;
  ssSegmentId: string | null;
  affiliateSegmentId: string | null;
};

export function resendLifecycleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResendLifecycleConfig | { refused: string } {
  const apiKey = env["RESEND_API_KEY"]?.trim();
  if (!apiKey) return { refused: "resend_api_key_unset" };
  return {
    apiKey,
    ssSegmentId: env["RESEND_SS_SEGMENT_ID"]?.trim() || null,
    affiliateSegmentId: env["RESEND_AFFILIATE_SEGMENT_ID"]?.trim() || null,
  };
}

export type ResendSubject = {
  kind: "smart_site" | "affiliate";
  email: string;
  firstName: string | null;
  /** Contract properties; affiliates carry none (first name and email only). */
  properties: Record<string, string | number>;
  /** True once the record says this contact is already in its segment. */
  inSegment: boolean;
};

export type ResendSendInput = {
  subject: ResendSubject;
  /** Contract v2 event name, or null for a contact-only update (E6). */
  event: string | null;
  eventPayload: Record<string, unknown> | null;
};

export type ResendSendResult =
  | { ok: true; addedToSegment: boolean }
  | { ok: false; error: string };

export type ResendOpts = {
  fetchImpl?: FetchLike;
  config?: ResendLifecycleConfig | { refused: string };
  minIntervalMs?: number;
};

let lastCallAt = 0;

async function pace(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const wait = lastCallAt + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

type Call = { ok: boolean; status: number; body: Record<string, unknown> };

async function resendCall(
  fetchImpl: FetchLike,
  apiKey: string,
  minIntervalMs: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Call> {
  if (body !== undefined) assertLifecyclePayloadSafe(body);
  await pace(minIntervalMs);
  const res = await fetchImpl(`${RESEND_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body: parsed };
}

function describe(step: string, call: Call): string {
  const name = typeof call.body["name"] === "string" ? call.body["name"] : null;
  const message = typeof call.body["message"] === "string" ? call.body["message"] : null;
  return `resend_${step}_http_${call.status}${name ? `:${name}` : ""}${message ? `:${message}` : ""}`;
}

export async function sendLifecycleToResend(
  input: ResendSendInput,
  opts: ResendOpts = {},
): Promise<ResendSendResult> {
  const config = opts.config ?? resendLifecycleConfigFromEnv();
  if ("refused" in config) return { ok: false, error: config.refused };
  const segmentId =
    input.subject.kind === "affiliate" ? config.affiliateSegmentId : config.ssSegmentId;
  if (!segmentId) {
    return {
      ok: false,
      error:
        input.subject.kind === "affiliate"
          ? "resend_affiliate_segment_id_unset"
          : "resend_ss_segment_id_unset",
    };
  }
  const email = input.subject.email.trim();
  if (!email) return { ok: false, error: "resend_contact_email_missing" };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const minInterval = opts.minIntervalMs ?? RESEND_MIN_INTERVAL_MS;
  const encodedEmail = encodeURIComponent(email);
  const contactFields: Record<string, unknown> = {
    ...(input.subject.firstName ? { first_name: input.subject.firstName } : {}),
    ...(Object.keys(input.subject.properties).length > 0
      ? { properties: input.subject.properties }
      : {}),
  };

  try {
    let addedToSegment = false;
    const patch = await resendCall(
      fetchImpl,
      config.apiKey,
      minInterval,
      "PATCH",
      `/contacts/${encodedEmail}`,
      contactFields,
    );
    if (patch.status === 404) {
      const create = await resendCall(fetchImpl, config.apiKey, minInterval, "POST", "/contacts", {
        email,
        ...contactFields,
        segments: [{ id: segmentId }],
      });
      if (!create.ok) return { ok: false, error: describe("contact_create", create) };
      addedToSegment = true;
    } else if (!patch.ok) {
      return { ok: false, error: describe("contact_update", patch) };
    } else if (!input.subject.inSegment) {
      const seg = await resendCall(
        fetchImpl,
        config.apiKey,
        minInterval,
        "POST",
        `/contacts/${encodedEmail}/segments/${encodeURIComponent(segmentId)}`,
      );
      if (!seg.ok) return { ok: false, error: describe("segment_add", seg) };
      addedToSegment = true;
    }

    if (input.event) {
      const ev = await resendCall(fetchImpl, config.apiKey, minInterval, "POST", "/events/send", {
        event: input.event,
        email,
        ...(input.eventPayload && Object.keys(input.eventPayload).length > 0
          ? { payload: input.eventPayload }
          : {}),
      });
      if (!ev.ok) return { ok: false, error: describe("event_send", ev) };
    }
    return { ok: true, addedToSegment };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? "resend_request_timeout"
          : err.message
        : "unknown_error";
    return { ok: false, error: message };
  }
}
