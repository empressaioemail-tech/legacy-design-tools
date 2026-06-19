/**
 * Cotality (CoreLogic Developer Platform) — shared OAuth client, CLIP
 * resolution, and JSON fetch helpers for all national Cotality adapters.
 *
 * Auth: OAuth2 client_credentials, per-product token host (Cotality enforces
 * strict product isolation; each app authenticates independently against its
 * own host). Property mints at `https://api1.cotality.com/oauth/token`; Spatial
 * Tile and RiskMeter mint at `https://api.cotality.com/oauth/token` (vendor-
 * confirmed 2026-06-11, Cotality Data Implementation Services). Credentials go
 * in an HTTP Basic auth header with `grant_type=client_credentials` in the
 * query string and an empty body (undici sends `Content-Length: 0`, which the
 * Incapsula WAF requires). grant_type in the body returns `invalid_request`;
 * credentials in the body return `InvalidClientIdentifier`. All three products
 * verified HTTP 200 against the live token endpoints 2026-06-15.
 *
 * Demo apps (env vars):
 *   COTALITY_PROPERTY_*     → Property API v2 (`property_auth`)
 *   COTALITY_SPATIALTILE_*  → Spatial Tile (`property_auth`)
 *   COTALITY_RISKMETER_*    → RiskMeter (`spatial_auth`)
 *
 * See `_research/2026-06-06_cotality_api_surface_catalog.md`.
 */

import { AdapterRunError } from "../types";

export const COTALITY_PROVIDER_LABEL = "Cotality";
export const COTALITY_INMEM_TTL_MS = 15 * 60 * 1000;
export const COTALITY_TIMEOUT_MS = 30_000;
export const COTALITY_TOKEN_EXPIRY_BUFFER_MS = 60_000;
export const COTALITY_FRESHNESS_THRESHOLD_MONTHS = 6;

export const COTALITY_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

// ---------------------------------------------------------------------------
// Endpoint constants — OPERATOR-CONFIRM from developer.corelogic.com
// ---------------------------------------------------------------------------

// Spatial Tile + RiskMeter token host (api.cotality.com). grant_type rides in
// the query because the request body is empty (Basic auth carries the creds).
export const COTALITY_TOKEN_URL_DEFAULT =
  "https://api.cotality.com/oauth/token?grant_type=client_credentials";
// Property API tokens mint at api1.cotality.com — vendor-confirmed 2026-06-11
// (Cotality Data Implementation Services); api.cotality.com returns
// `InvalidClientIdentifier` for the Property app.
export const COTALITY_PROPERTY_TOKEN_URL_DEFAULT =
  "https://api1.cotality.com/oauth/token?grant_type=client_credentials";
export const COTALITY_API_BASE_DEFAULT = "https://api.cotality.com";
export const COTALITY_PROPERTY_BASE_URL_DEFAULT =
  "https://api1.cotality.com/v2/properties";
export const COTALITY_SPATIALTILE_BASE_URL_DEFAULT =
  "https://api.cotality.com/spatial-tile";
export const COTALITY_RISKMETER_BASE_URL_DEFAULT =
  "https://api.cotality.com/riskmeter-api";

/**
 * Per-product OAuth token host. Each product's host is overridable without a
 * redeploy via its own env var; `COTALITY_TOKEN_URL` remains a legacy global
 * override (applies to every product) for back-compat.
 */
export function cotalityTokenUrl(app: CotalityOAuthApp = "property"): string {
  const legacyOverride = process.env.COTALITY_TOKEN_URL;
  switch (app) {
    case "property":
      return (
        process.env.COTALITY_PROPERTY_TOKEN_URL ??
        legacyOverride ??
        COTALITY_PROPERTY_TOKEN_URL_DEFAULT
      );
    case "spatialtile":
      return (
        process.env.COTALITY_SPATIALTILE_TOKEN_URL ??
        legacyOverride ??
        COTALITY_TOKEN_URL_DEFAULT
      );
    case "riskmeter":
      return (
        process.env.COTALITY_RISKMETER_TOKEN_URL ??
        legacyOverride ??
        COTALITY_TOKEN_URL_DEFAULT
      );
  }
}

export function cotalityPropertyBaseUrl(): string {
  return (
    process.env.COTALITY_PROPERTY_BASE_URL ??
    COTALITY_PROPERTY_BASE_URL_DEFAULT
  );
}

export function cotalitySpatialTileBaseUrl(): string {
  return (
    process.env.COTALITY_SPATIALTILE_BASE_URL ??
    COTALITY_SPATIALTILE_BASE_URL_DEFAULT
  );
}

export function cotalityRiskMeterBaseUrl(): string {
  return (
    process.env.COTALITY_RISKMETER_BASE_URL ??
    COTALITY_RISKMETER_BASE_URL_DEFAULT
  );
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export type CotalityOAuthApp = "property" | "spatialtile" | "riskmeter";

interface CotalityAppCredentials {
  clientId: string;
  clientSecret: string;
}

interface CotalityTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const cotalityTokenCache = new Map<
  CotalityOAuthApp,
  CotalityTokenCacheEntry
>();
const cotalityTokenInflight = new Map<
  CotalityOAuthApp,
  Promise<string>
>();

const CRED_ENV: Record<
  CotalityOAuthApp,
  { key: string; secret: string; label: string }
> = {
  property: {
    key: "COTALITY_PROPERTY_KEY",
    secret: "COTALITY_PROPERTY_SECRET",
    label: "COTALITY_PROPERTY_KEY/SECRET",
  },
  spatialtile: {
    key: "COTALITY_SPATIALTILE_KEY",
    secret: "COTALITY_SPATIALTILE_SECRET",
    label: "COTALITY_SPATIALTILE_KEY/SECRET",
  },
  riskmeter: {
    key: "COTALITY_RISKMETER_KEY",
    secret: "COTALITY_RISKMETER_SECRET",
    label: "COTALITY_RISKMETER_KEY/SECRET",
  },
};

/** OAuth security scheme name per demo app (for adapter metadata). */
export const COTALITY_OAUTH_SCHEME: Record<CotalityOAuthApp, string> = {
  property: "property_auth",
  spatialtile: "property_auth",
  riskmeter: "spatial_auth",
};

export function readCotalityAppCredentials(
  app: CotalityOAuthApp,
): CotalityAppCredentials | null {
  const spec = CRED_ENV[app];
  const clientId = process.env[spec.key];
  const clientSecret = process.env[spec.secret];
  if (!clientId || clientId.length === 0) return null;
  if (!clientSecret || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

export function requireCotalityAppCredentials(
  app: CotalityOAuthApp,
  fallbackMessage?: string,
): CotalityAppCredentials {
  const creds = readCotalityAppCredentials(app);
  if (creds) return creds;
  throw new AdapterRunError(
    "no-coverage",
    fallbackMessage ??
      `${CRED_ENV[app].label} is not configured on this deployment. Regrid remains the active national parcel/zoning provider.`,
  );
}

export function __resetCotalityTokenCacheForTests(): void {
  cotalityTokenCache.clear();
  cotalityTokenInflight.clear();
}

type CotalityLogLevel = "info" | "warn";

function cotalityLogEvent(
  level: CotalityLogLevel,
  msg: string,
  adapterKey: string,
  fields: Record<string, unknown>,
): void {
  const out = { level, msg, adapter_key: adapterKey, ...fields };
  let line: string;
  try {
    line = JSON.stringify(out);
  } catch {
    line = JSON.stringify({ level, msg, adapter_key: adapterKey });
  }
  if (level === "warn") console.warn(line);
  else console.info(line);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("client_secret")) {
      u.searchParams.set("client_secret", "<redacted>");
    }
    return u.toString();
  } catch {
    return url;
  }
}

interface GetCotalityAccessTokenArgs {
  app: CotalityOAuthApp;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}

export async function getCotalityAccessToken(
  args: GetCotalityAccessTokenArgs,
): Promise<string> {
  const { app, fetchImpl, signal, adapterKeyForLog } = args;
  requireCotalityAppCredentials(app);

  const now = Date.now();
  const cached = cotalityTokenCache.get(app);
  if (cached && cached.expiresAt > now) return cached.accessToken;

  const inflight = cotalityTokenInflight.get(app);
  if (inflight) return inflight;

  const creds = readCotalityAppCredentials(app)!;
  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const tokenUrl = cotalityTokenUrl(app);

  const promise = (async (): Promise<string> => {
    cotalityLogEvent("info", "cotality oauth token start", adapterKeyForLog, {
      app,
      scheme: COTALITY_OAUTH_SCHEME[app],
      token_url: redactUrl(tokenUrl),
    });
    const startedAtMs = Date.now();

    // Credentials as HTTP Basic auth; grant_type rides in the query (already on
    // tokenUrl). No body — undici sends Content-Length: 0, which the Incapsula
    // WAF requires. grant_type in the body -> invalid_request; creds in the
    // body -> InvalidClientIdentifier.
    const basicAuth = Buffer.from(
      `${creds.clientId}:${creds.clientSecret}`,
    ).toString("base64");

    let res: Response;
    try {
      res = await fetcher(tokenUrl, {
        method: "POST",
        signal,
        headers: {
          "User-Agent": COTALITY_USER_AGENT,
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
      });
    } catch (err) {
      const throwExcerpt =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      cotalityLogEvent("warn", "cotality oauth token failed", adapterKeyForLog, {
        app,
        error_class: "network",
        duration_ms: Date.now() - startedAtMs,
        throw_excerpt: throwExcerpt,
      });
      throw new AdapterRunError(
        "network-error",
        `Cotality OAuth token request failed (${app} app): ${throwExcerpt}. Use Force refresh to retry.`,
      );
    }

    if (!res.ok) {
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await res.text()).slice(0, 256);
      } catch {
        /* swallow */
      }
      cotalityLogEvent("warn", "cotality oauth token failed", adapterKeyForLog, {
        app,
        error_class: "status",
        http_status: res.status,
        duration_ms: Date.now() - startedAtMs,
        body_excerpt: bodyExcerpt,
      });
      throw new AdapterRunError(
        "upstream-error",
        `Cotality OAuth token responded HTTP ${res.status} (${app} app).${
          bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
        } Check consumer KEY/SECRET for this demo app.`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AdapterRunError(
        "parse-error",
        `Cotality OAuth token response was not JSON (${app} app): ${message}`,
      );
    }

    const tokenObj = json as { access_token?: unknown; expires_in?: unknown };
    const accessToken =
      typeof tokenObj.access_token === "string" ? tokenObj.access_token : null;
    if (!accessToken) {
      throw new AdapterRunError(
        "parse-error",
        `Cotality OAuth token response missing access_token (${app} app).`,
      );
    }

    // Cotality returns expires_in as a numeric string (e.g. "3599").
    const expiresInRaw = Number(tokenObj.expires_in);
    const expiresInSec =
      Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
    const expiresAt =
      Date.now() + expiresInSec * 1000 - COTALITY_TOKEN_EXPIRY_BUFFER_MS;

    cotalityTokenCache.set(app, { accessToken, expiresAt });
    cotalityLogEvent("info", "cotality oauth token ok", adapterKeyForLog, {
      app,
      duration_ms: Date.now() - startedAtMs,
      expires_in_sec: expiresInSec,
    });
    return accessToken;
  })();

  const tracked = promise.finally(() => {
    const entry = cotalityTokenInflight.get(app);
    if (entry === tracked) cotalityTokenInflight.delete(app);
  });

  cotalityTokenInflight.set(app, tracked);
  return tracked;
}

// ---------------------------------------------------------------------------
// HTTP JSON fetch
// ---------------------------------------------------------------------------

export async function cotalityFetchJson(args: {
  url: string;
  bearerToken: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  label: string;
}): Promise<unknown> {
  const { url, bearerToken, fetchImpl, signal, adapterKeyForLog, label } =
    args;
  const startedAtMs = Date.now();

  cotalityLogEvent("info", "cotality request start", adapterKeyForLog, {
    label,
    url: redactUrl(url),
  });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal,
      headers: {
        "User-Agent": COTALITY_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
    });
  } catch (err) {
    const throwExcerpt =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label,
      error_class: "network",
      duration_ms: Date.now() - startedAtMs,
      throw_excerpt: throwExcerpt,
    });
    throw new AdapterRunError(
      "network-error",
      `Cotality ${label} did not get a response. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
    );
  }

  if (!res.ok) {
    let bodyExcerpt = "";
    try {
      bodyExcerpt = (await res.text()).slice(0, 256);
    } catch {
      /* swallow */
    }
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label,
      error_class: "status",
      http_status: res.status,
      duration_ms: Date.now() - startedAtMs,
      body_excerpt: bodyExcerpt,
    });
    throw new AdapterRunError(
      "upstream-error",
      `Cotality ${label} responded HTTP ${res.status}.${
        bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
      } Use Force refresh to retry.`,
    );
  }

  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterRunError(
      "parse-error",
      `Cotality ${label} response was not JSON: ${message}`,
    );
  }
}

export async function cotalityGetWithApp(args: {
  app: CotalityOAuthApp;
  path: string;
  baseUrl?: string;
  query?: Record<string, string | number | undefined | null>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  label: string;
}): Promise<unknown> {
  const {
    app,
    path,
    baseUrl,
    query,
    fetchImpl,
    signal,
    adapterKeyForLog,
    label,
  } = args;

  if (!readCotalityAppCredentials(app)) {
    throw new AdapterRunError(
      "no-coverage",
      `${CRED_ENV[app].label} is not configured.`,
    );
  }

  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const token = await getCotalityAccessToken({
    app,
    fetchImpl: fetcher,
    signal,
    adapterKeyForLog,
  });

  const base =
    baseUrl ??
    (app === "riskmeter"
      ? cotalityRiskMeterBaseUrl()
      : app === "spatialtile"
        ? cotalitySpatialTileBaseUrl()
        : cotalityPropertyBaseUrl());

  const url = new URL(
    `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  return cotalityFetchJson({
    url: url.toString(),
    bearerToken: token,
    fetchImpl: fetcher,
    signal,
    adapterKeyForLog,
    label,
  });
}

// ---------------------------------------------------------------------------
// CLIP resolution (Property geocode search)
// ---------------------------------------------------------------------------

export interface CotalityClipContext {
  clip: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  county?: string;
  raw?: unknown;
}

interface ClipDedupEntry {
  promise: Promise<CotalityClipContext>;
  expiresAt: number;
}

const clipDedup = new Map<string, ClipDedupEntry>();

function clipDedupKey(
  streetAddress: string,
  city: string,
  state: string,
): string {
  return `${streetAddress.trim().toLowerCase()}|${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
}

/** US state name → 2-letter abbreviation for Cotality catalog geocode. */
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

function normalizeStateCode(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const abbr = US_STATE_ABBR[t.toLowerCase()];
  return abbr ?? null;
}

/**
 * Parse a US mailing address into Cotality catalog geocode components.
 * Prefers explicit city/state when supplied; otherwise parses "street, City, ST zip".
 */
export function parseCotalityCatalogAddress(args: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
}): { streetAddress: string; city: string; state: string } | null {
  const explicitCity = args.city?.trim() ?? "";
  const explicitState = normalizeStateCode(args.state);
  const explicitStreet = args.streetAddress?.trim() ?? "";

  if (explicitStreet && explicitCity && explicitState) {
    return {
      streetAddress: explicitStreet,
      city: explicitCity,
      state: explicitState,
    };
  }

  const addr = args.address?.trim() ?? "";
  if (!addr) return null;

  // "613 Sturgeon Dr, San Marcos, TX 78666" or "5225 COLLINS AVE, MIAMI BEACH, FL 33140"
  const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const streetAddress = explicitStreet || parts[0];
  const cityPart = explicitCity || parts[parts.length - 2] || parts[1];
  const stateZipPart = parts[parts.length - 1] ?? "";
  const stateFromZip = stateZipPart.match(/\b([A-Za-z]{2})\b(?:\s+\d{5})?/)?.[1];
  const state = explicitState ?? normalizeStateCode(stateFromZip ?? stateZipPart);

  if (!streetAddress || !cityPart || !state) return null;
  return { streetAddress, city: cityPart, state };
}

function bodyIndicatesClipNotFound(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const messages = json.messages;
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const msg = (m as Record<string, unknown>).message;
        if (typeof msg === "string" && /clip not found/i.test(msg)) return true;
      }
    }
    if (typeof json.message === "string" && /clip not found/i.test(json.message)) {
      return true;
    }
  } catch {
    if (/clip not found/i.test(trimmed)) return true;
  }
  return false;
}

async function cotalityFetchGeocodeCatalog(args: {
  streetAddress: string;
  city: string;
  state: string;
  bearerToken: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}): Promise<unknown> {
  const {
    streetAddress,
    city,
    state,
    bearerToken,
    fetchImpl,
    signal,
    adapterKeyForLog,
  } = args;
  const base = cotalityPropertyBaseUrl().replace(/\/$/, "");
  const url = new URL(`${base}/search/geocode`);
  url.searchParams.set("streetAddress", streetAddress);
  url.searchParams.set("city", city);
  url.searchParams.set("state", state);
  url.searchParams.set("bestMatch", "true");

  const startedAtMs = Date.now();
  cotalityLogEvent("info", "cotality request start", adapterKeyForLog, {
    label: "property-geocode",
    url: redactUrl(url.toString()),
  });

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      signal,
      headers: {
        "User-Agent": COTALITY_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
    });
  } catch (err) {
    const throwExcerpt =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label: "property-geocode",
      error_class: "network",
      duration_ms: Date.now() - startedAtMs,
      throw_excerpt: throwExcerpt,
    });
    throw new AdapterRunError(
      "network-error",
      `Cotality property-geocode did not get a response. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
    );
  }

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }

  if (res.status === 404) {
    if (bodyIndicatesClipNotFound(bodyText)) {
      cotalityLogEvent("info", "cotality geocode clip not found", adapterKeyForLog, {
        label: "property-geocode",
        http_status: 404,
        duration_ms: Date.now() - startedAtMs,
        body_excerpt: bodyText.slice(0, 256),
      });
      throw new AdapterRunError(
        "no-coverage",
        "Address not in Cotality coverage (Clip not found).",
      );
    }
    cotalityLogEvent("warn", "cotality geocode routing 404", adapterKeyForLog, {
      label: "property-geocode",
      error_class: "routing-404",
      http_status: 404,
      duration_ms: Date.now() - startedAtMs,
      body_excerpt: bodyText.slice(0, 256),
    });
    throw new AdapterRunError(
      "upstream-error",
      `Cotality property-geocode responded HTTP 404 with empty or non-catalog body (likely routing/host misconfiguration). Use Force refresh to retry.`,
    );
  }

  if (!res.ok) {
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label: "property-geocode",
      error_class: "status",
      http_status: res.status,
      duration_ms: Date.now() - startedAtMs,
      body_excerpt: bodyText.slice(0, 256),
    });
    throw new AdapterRunError(
      "upstream-error",
      `Cotality property-geocode responded HTTP ${res.status}.${
        bodyText ? ` Upstream: ${bodyText.slice(0, 256)}` : ""
      } Use Force refresh to retry.`,
    );
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterRunError(
      "parse-error",
      `Cotality property-geocode response was not JSON: ${message}`,
    );
  }
}

export function __resetCotalityClipDedupForTests(): void {
  clipDedup.clear();
}

function extractClipFromSearchResponse(json: unknown): CotalityClipContext | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  const candidates: unknown[] = [];
  if (Array.isArray(root.items)) candidates.push(...root.items);
  if (Array.isArray(root.properties)) candidates.push(...root.properties);
  if (Array.isArray(root.results)) candidates.push(...root.results);
  if (Array.isArray(root.data)) candidates.push(...root.data);
  if (root.clip != null) candidates.push(root);

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const clip =
      row.clip ??
      row.CLIP ??
      row.propertyClip ??
      (row.property as Record<string, unknown> | undefined)?.clip;
    if (clip == null) continue;
    const clipStr = String(clip);
    const lat =
      pickNum(row.latitude) ??
      pickNum(row.lat) ??
      pickNum(
        (row.coordinates as Record<string, unknown> | undefined)?.latitude,
      );
    const lng =
      pickNum(row.longitude) ??
      pickNum(row.lon) ??
      pickNum(row.lng) ??
      pickNum(
        (row.coordinates as Record<string, unknown> | undefined)?.longitude,
      );
    const county =
      typeof row.county === "string"
        ? row.county
        : typeof row.countyName === "string"
          ? row.countyName
          : undefined;
    return {
      clip: clipStr,
      latitude: lat ?? NaN,
      longitude: lng ?? NaN,
      county,
      raw: item,
    };
  }
  return null;
}

function pickNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function resolveCotalityClip(args: {
  latitude: number;
  longitude: number;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}): Promise<CotalityClipContext> {
  const {
    latitude,
    longitude,
    address,
    city,
    state,
    streetAddress,
    fetchImpl,
    signal,
    adapterKeyForLog,
  } = args;

  const catalog = parseCotalityCatalogAddress({
    address,
    city,
    state,
    streetAddress,
  });
  if (!catalog) {
    throw new AdapterRunError(
      "no-coverage",
      "Cannot resolve Cotality CLIP: engagement address must include street, city, and state for catalog geocode.",
    );
  }

  const key = clipDedupKey(
    catalog.streetAddress,
    catalog.city,
    catalog.state,
  );
  const now = Date.now();
  const existing = clipDedup.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = (async (): Promise<CotalityClipContext> => {
    if (!readCotalityAppCredentials("property")) {
      throw new AdapterRunError(
        "no-coverage",
        "COTALITY_PROPERTY_KEY/SECRET is not configured. Cannot resolve Cotality CLIP.",
      );
    }

    const fetcher: typeof fetch = fetchImpl ?? fetch;
    const token = await getCotalityAccessToken({
      app: "property",
      fetchImpl: fetcher,
      signal,
      adapterKeyForLog,
    });

    const json = await cotalityFetchGeocodeCatalog({
      streetAddress: catalog.streetAddress,
      city: catalog.city,
      state: catalog.state,
      bearerToken: token,
      fetchImpl: fetcher,
      signal,
      adapterKeyForLog,
    });

    const parsed = extractClipFromSearchResponse(json);
    if (!parsed) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality geocode search returned no CLIP for this address.",
      );
    }

    return {
      ...parsed,
      latitude: Number.isFinite(parsed.latitude) ? parsed.latitude : latitude,
      longitude: Number.isFinite(parsed.longitude)
        ? parsed.longitude
        : longitude,
      address: address ?? null,
    };
  })();

  clipDedup.set(key, { promise, expiresAt: now + COTALITY_INMEM_TTL_MS });
  promise.catch(() => {
    const entry = clipDedup.get(key);
    if (entry?.promise === promise) clipDedup.delete(key);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Geometry + feature helpers
// ---------------------------------------------------------------------------

function parseWktCoordinatePairs(content: string): number[][] {
  const pairs: number[][] = [];
  const re =
    /(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    pairs.push([Number(match[1]), Number(match[2])]);
  }
  return pairs;
}

function extractWktParenGroups(body: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(body.slice(start, i));
        start = -1;
      }
    }
  }
  return groups;
}

function parseWktCoordinates(wkt: string): unknown | null {
  const raw = wkt.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  if (upper.startsWith("MULTIPOLYGON")) {
    const body = raw.replace(/^MULTIPOLYGON\s*/i, "").trim();
    const polys = extractWktParenGroups(body);
    if (polys.length === 0) return null;
    const result: number[][][][] = [];
    for (const poly of polys) {
      const rings = extractWktParenGroups(poly);
      const parsedRings = (rings.length > 0 ? rings : [poly]).map(
        parseWktCoordinatePairs,
      );
      if (parsedRings.length > 0 && parsedRings[0].length > 0) {
        result.push(parsedRings);
      }
    }
    return result.length > 0 ? result : null;
  }

  if (upper.startsWith("POLYGON")) {
    const body = raw.replace(/^POLYGON\s*/i, "").trim();
    const rings = extractWktParenGroups(body);
    const parsedRings = (rings.length > 0 ? rings : [body]).map(
      parseWktCoordinatePairs,
    );
    return parsedRings.length > 0 && parsedRings[0].length > 0
      ? parsedRings
      : null;
  }

  return null;
}

export function inferPolygonGeomType(
  coords: unknown,
): "Polygon" | "MultiPolygon" {
  if (
    Array.isArray(coords) &&
    Array.isArray(coords[0]) &&
    Array.isArray(coords[0][0]) &&
    Array.isArray(coords[0][0][0])
  ) {
    return "MultiPolygon";
  }
  return "Polygon";
}

export interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
  id?: string | number;
}

export function normalizeGeometryToCoordinates(geom: unknown): unknown | null {
  if (!geom) return null;
  if (typeof geom === "object") {
    const g = geom as Record<string, unknown>;
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      if (Array.isArray(g.coordinates)) return g.coordinates;
    }
    if (Array.isArray(g.rings)) return g.rings;
    if (g.geometry) return normalizeGeometryToCoordinates(g.geometry);
    if (g.shape) return normalizeGeometryToCoordinates(g.shape);
    if (Array.isArray(g.parcels) && g.parcels.length > 0) {
      const first = g.parcels[0] as Record<string, unknown>;
      return normalizeGeometryToCoordinates(first.geometry ?? first);
    }
  }
  if (typeof geom === "string") {
    const parsed = parseWktCoordinates(geom);
    if (parsed) return parsed;
  }
  return null;
}

export function buildPolygonFeature(
  geometryCoords: unknown,
  baseProps: Record<string, unknown>,
  geomType: "Polygon" | "MultiPolygon" = "Polygon",
): NormalizedFeature {
  return {
    type: "Feature",
    geometry: {
      type: geomType,
      coordinates: geometryCoords,
    },
    properties: { ...baseProps },
  };
}

export function extractParcelGeometryFromSpatialTile(
  json: unknown,
): unknown | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const list =
    (Array.isArray(root.parcels) ? root.parcels : null) ??
    (Array.isArray(root.items) ? root.items : null) ??
    (Array.isArray(root.features) ? root.features : null);
  if (list && list.length > 0) {
    const first = list[0] as Record<string, unknown>;
    return (
      first.geometry ??
      (first.parcel as Record<string, unknown> | undefined)?.geometry ??
      first
    );
  }
  return root.geometry ?? null;
}

export function snapshotDateFromJson(json: unknown): string {
  if (!json || typeof json !== "object") return new Date().toISOString();
  const root = json as Record<string, unknown>;
  const candidates = [
    root.vintage,
    root.lastUpdated,
    root.asOf,
    root.refreshDate,
    root.snapshotDate,
    root.taxYear ? `${root.taxYear}-01-01` : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return new Date().toISOString();
}

export function providerLabel(county?: string | null): string {
  if (county && county.length > 0) {
    return `${COTALITY_PROVIDER_LABEL} (via ${county})`;
  }
  return COTALITY_PROVIDER_LABEL;
}

export function cotalityAppliesGeocoded(ctx: {
  parcel: { latitude: number; longitude: number };
}): boolean {
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

/** Adapter metadata stamped on payloads for operator smoke tracking. */
export function cotalityAdapterMeta(
  adapterKey: string,
  app: CotalityOAuthApp,
  liveSmoke: "pending" | "not-run" | "passed" | "failed" = "pending",
): Record<string, unknown> {
  return {
    source: "cotality",
    adapterKey,
    cotalityDemoApp: app,
    cotalityOAuthScheme: COTALITY_OAUTH_SCHEME[app],
    liveSmokeStatus: liveSmoke,
  };
}
