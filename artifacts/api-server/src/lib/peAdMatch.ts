/**
 * Ad-platform match keys for server-side Meta CAPI (and GA4 Measurement
 * Protocol) events that cortex sends with NO browser request in hand:
 * CompleteRegistration (session-exchange, called server-to-server by the
 * hauska-map BFF) and Purchase (the Stripe webhook).
 *
 * WHERE THEY COME FROM:
 *   - sign-in: the BFF's OAuth callback / magic-link verify is the browser's
 *     own request; it forwards `metaMatch` in the exchange body.
 *   - checkout: the BFF's deep proxy forwards `x-hauska-*` headers on the
 *     checkout-creation POST only; cortex copies them onto the Stripe
 *     Checkout Session metadata, and the webhook reads them back.
 *   - the outbox: copied onto the row payload as flat scalar keys
 *     (`ALLOWED_PAYLOAD_KEYS`), so a retry from the drain still has them.
 *
 * Per Meta's spec these are sent UNHASHED (ip, ua, fbp, fbc). Nothing here
 * is parcel data; every value is shape-validated and anything that is not
 * what it claims to be is DROPPED, never forwarded.
 */

export type AdMatch = {
  clientIp?: string;
  clientUserAgent?: string;
  fbp?: string;
  fbc?: string;
  gaClientId?: string;
  gaSessionId?: string;
};

const META_CLICK_COOKIE = /^fb\.\d\.\d+\.[^\s;]+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;
const GA_CLIENT_ID = /^\d{1,20}\.\d{1,20}$/;
const GA_SESSION_ID = /^\d{1,20}$/;

/** Stripe metadata values are capped at 500 characters. */
const MAX_UA = 500;

export function normalizeIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (IPV4.test(v)) return v;
  if (v.includes(":") && IPV6.test(v) && v.length <= 45) return v.toLowerCase();
  return undefined;
}

export function normalizeUa(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v.slice(0, MAX_UA) : undefined;
}

export function normalizeMetaCookie(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && v.length <= 500 && META_CLICK_COOKIE.test(v) ? v : undefined;
}

function normalizeGaClientId(value: unknown): string | undefined {
  return typeof value === "string" && GA_CLIENT_ID.test(value.trim()) ? value.trim() : undefined;
}

function normalizeGaSessionId(value: unknown): string | undefined {
  return typeof value === "string" && GA_SESSION_ID.test(value.trim()) ? value.trim() : undefined;
}

/** Validate every field; drop anything malformed. */
export function normalizeAdMatch(raw: unknown): AdMatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: AdMatch = {};
  const ip = normalizeIp(r["clientIp"]);
  if (ip) out.clientIp = ip;
  const ua = normalizeUa(r["clientUserAgent"]);
  if (ua) out.clientUserAgent = ua;
  const fbp = normalizeMetaCookie(r["fbp"]);
  if (fbp) out.fbp = fbp;
  const fbc = normalizeMetaCookie(r["fbc"]);
  if (fbc) out.fbc = fbc;
  const cid = normalizeGaClientId(r["gaClientId"]);
  if (cid) out.gaClientId = cid;
  const sid = normalizeGaSessionId(r["gaSessionId"]);
  if (sid) out.gaSessionId = sid;
  return out;
}

/** The BFF's checkout-creation headers (hauska-map api/_lib/ad-match-headers.ts). */
export const AD_MATCH_HEADERS = {
  clientIp: "x-hauska-client-ip",
  clientUserAgent: "x-hauska-client-ua",
  fbp: "x-hauska-fbp",
  fbc: "x-hauska-fbc",
  gaClientId: "x-hauska-ga-cid",
  gaSessionId: "x-hauska-ga-sid",
} as const;

type HeaderReader = { header(name: string): string | undefined };

/**
 * Read the forwarded match keys from a checkout-creation request.
 *
 * NO FALLBACK to this request's own IP or user agent: the caller is the BFF,
 * server to server, so those would be Vercel's, which is exactly the
 * "proxy's IP" the brief forbids. Absent stays absent.
 */
export function adMatchFromHeaders(req: HeaderReader): AdMatch {
  return normalizeAdMatch({
    clientIp: req.header(AD_MATCH_HEADERS.clientIp),
    clientUserAgent: req.header(AD_MATCH_HEADERS.clientUserAgent),
    fbp: req.header(AD_MATCH_HEADERS.fbp),
    fbc: req.header(AD_MATCH_HEADERS.fbc),
    gaClientId: req.header(AD_MATCH_HEADERS.gaClientId),
    gaSessionId: req.header(AD_MATCH_HEADERS.gaSessionId),
  });
}

/** Stripe Checkout Session metadata keys (40-char key / 500-char value limits). */
export const AD_MATCH_STRIPE_METADATA = {
  clientIp: "ad_client_ip",
  clientUserAgent: "ad_client_ua",
  fbp: "ad_fbp",
  fbc: "ad_fbc",
  gaClientId: "ad_ga_cid",
  gaSessionId: "ad_ga_sid",
} as const;

/** Form params for `stripePostForm("/checkout/sessions", …)`. Session only, never the subscription. */
export function adMatchToStripeParams(match: AdMatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(AD_MATCH_STRIPE_METADATA) as [keyof AdMatch, string][]) {
    const v = match[field];
    if (v) out[`metadata[${key}]`] = v;
  }
  return out;
}

export function adMatchFromStripeMetadata(meta: unknown): AdMatch {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Record<string, unknown>;
  return normalizeAdMatch({
    clientIp: m[AD_MATCH_STRIPE_METADATA.clientIp],
    clientUserAgent: m[AD_MATCH_STRIPE_METADATA.clientUserAgent],
    fbp: m[AD_MATCH_STRIPE_METADATA.fbp],
    fbc: m[AD_MATCH_STRIPE_METADATA.fbc],
    gaClientId: m[AD_MATCH_STRIPE_METADATA.gaClientId],
    gaSessionId: m[AD_MATCH_STRIPE_METADATA.gaSessionId],
  });
}

/** Flat scalar payload keys on the outbox row (see peLifecycleDenylist). */
export const AD_MATCH_PAYLOAD_KEYS = {
  clientIp: "adClientIp",
  clientUserAgent: "adClientUa",
  fbp: "adFbp",
  fbc: "adFbc",
  gaClientId: "adGaClientId",
  gaSessionId: "adGaSessionId",
} as const;

export function adMatchToPayload(match: AdMatch | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!match) return out;
  for (const [field, key] of Object.entries(AD_MATCH_PAYLOAD_KEYS) as [keyof AdMatch, string][]) {
    const v = match[field];
    if (v) out[key] = v;
  }
  return out;
}

export function adMatchFromPayload(payload: Record<string, unknown>): AdMatch {
  return normalizeAdMatch({
    clientIp: payload[AD_MATCH_PAYLOAD_KEYS.clientIp],
    clientUserAgent: payload[AD_MATCH_PAYLOAD_KEYS.clientUserAgent],
    fbp: payload[AD_MATCH_PAYLOAD_KEYS.fbp],
    fbc: payload[AD_MATCH_PAYLOAD_KEYS.fbc],
    gaClientId: payload[AD_MATCH_PAYLOAD_KEYS.gaClientId],
    gaSessionId: payload[AD_MATCH_PAYLOAD_KEYS.gaSessionId],
  });
}
