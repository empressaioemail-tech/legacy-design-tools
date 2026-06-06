/**
 * Cotality (CoreLogic Developer Platform / Apigee) — national parcel + zoning
 * adapter pair.
 *
 * Per 2026-06-06 decision + OAuth rework (2026-06-06):
 * Cotality uses OAuth2 client_credentials — each demo app has a consumer KEY
 * (client_id) + consumer SECRET (client_secret) exchanged for a short-lived
 * bearer token. Three independent demo apps; this PR uses Property + SpatialTile:
 *
 *   COTALITY_PROPERTY_KEY / COTALITY_PROPERTY_SECRET
 *     → Property API v2.0, Property Search, Property AVM (parcel attrs + zoning)
 *   COTALITY_SPATIALTILE_KEY / COTALITY_SPATIALTILE_SECRET
 *     → Spatial Tile (parcel polygon geometry)
 *   COTALITY_RISKMETER_KEY / COTALITY_RISKMETER_SECRET
 *     → RiskMeter (climate/flood) — env vars recognized but unused until climate dispatch
 *
 * Adapter contract unchanged from Regrid SCOPE B:
 *   payload.parcel / payload.zoning = GeoJSON Feature (Polygon/MultiPolygon geometry)
 *
 * Auth gate: missing KEY or SECRET for a required app → clean no-coverage, zero
 * network (Regrid remains fallback). Tokens cached in-memory until ~60s before expiry.
 *
 * NOT Trestle (api.cotality.com/trestle/...) — that is MLS OData, different product.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { CACHE_COORDINATE_PRECISION } from "../cache";

const COTALITY_PROVIDER_LABEL = "Cotality";

/** In-memory point-response dedup TTL (ms). Matches Regrid / fcc:broadband. */
const COTALITY_INMEM_TTL_MS = 15 * 60 * 1000;

/** Default per-adapter timeout floor (ms). */
const COTALITY_TIMEOUT_MS = 30_000;

/** Refresh bearer tokens this many ms before Apigee expires_in. */
const COTALITY_TOKEN_EXPIRY_BUFFER_MS = 60_000;

const COTALITY_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

export const COTALITY_FRESHNESS_THRESHOLD_MONTHS = 6;

// ---------------------------------------------------------------------------
// Endpoint constants — OPERATOR-CONFIRM from developer.corelogic.com API DOCUMENTATION
// ---------------------------------------------------------------------------

/** OPERATOR-CONFIRM: Apigee OAuth2 token endpoint (likely api-prod.corelogic.com). */
export const COTALITY_TOKEN_URL_DEFAULT =
  "https://api-prod.corelogic.com/oauth/token";

/** OPERATOR-CONFIRM: Property API v2 base (parcel characteristics + zoning fields). */
export const COTALITY_PROPERTY_BASE_URL_DEFAULT =
  "https://api-prod.corelogic.com/property/v2";

/** OPERATOR-CONFIRM: Spatial Tile API base (parcel polygon geometry). */
export const COTALITY_SPATIALTILE_BASE_URL_DEFAULT =
  "https://api-prod.corelogic.com/spatialtile/v1";

/** OPERATOR-CONFIRM: relative path on PROPERTY base for lat/lng point lookup. */
export const COTALITY_PROPERTY_POINT_PATH_DEFAULT = "/point";

/** OPERATOR-CONFIRM: relative path on SPATIALTILE base for lat/lng geometry lookup. */
export const COTALITY_SPATIALTILE_POINT_PATH_DEFAULT = "/point";

export function cotalityTokenUrl(): string {
  return process.env.COTALITY_TOKEN_URL ?? COTALITY_TOKEN_URL_DEFAULT;
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

export function cotalityPropertyPointPath(): string {
  return (
    process.env.COTALITY_PROPERTY_POINT_PATH ??
    COTALITY_PROPERTY_POINT_PATH_DEFAULT
  );
}

export function cotalitySpatialTilePointPath(): string {
  return (
    process.env.COTALITY_SPATIALTILE_POINT_PATH ??
    COTALITY_SPATIALTILE_POINT_PATH_DEFAULT
  );
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type CotalityLogLevel = "info" | "warn";
type CotalityLogFields = Record<string, unknown>;

function cotalityLogEvent(
  level: CotalityLogLevel,
  msg: string,
  adapterKey: string,
  fields: CotalityLogFields,
): void {
  const out = { level, msg, adapter_key: adapterKey, ...fields };
  let line: string;
  try {
    line = JSON.stringify(out);
  } catch {
    line = JSON.stringify({ level, msg, adapter_key: adapterKey });
  }
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
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

// ---------------------------------------------------------------------------
// OAuth2 client_credentials — per demo-app token cache
// ---------------------------------------------------------------------------

export type CotalityOAuthApp = "property" | "spatialtile";

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

/** In-flight token fetches deduped per app (concurrent adapters share one POST). */
const cotalityTokenInflight = new Map<
  CotalityOAuthApp,
  Promise<string>
>();

export function readCotalityAppCredentials(
  app: CotalityOAuthApp,
): CotalityAppCredentials | null {
  const keyVar =
    app === "property"
      ? "COTALITY_PROPERTY_KEY"
      : "COTALITY_SPATIALTILE_KEY";
  const secretVar =
    app === "property"
      ? "COTALITY_PROPERTY_SECRET"
      : "COTALITY_SPATIALTILE_SECRET";
  const clientId = process.env[keyVar];
  const clientSecret = process.env[secretVar];
  if (!clientId || clientId.length === 0) return null;
  if (!clientSecret || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

/** Test-only — clear OAuth token cache between vitest cases. */
export function __resetCotalityTokenCacheForTests(): void {
  cotalityTokenCache.clear();
  cotalityTokenInflight.clear();
}

interface GetCotalityAccessTokenArgs {
  app: CotalityOAuthApp;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}

/**
 * Exchange client_id + client_secret for a bearer token; cache until ~60s before
 * Apigee expires_in. Uses application/x-www-form-urlencoded body per standard
 * OAuth2 client_credentials (operator may confirm Basic-auth variant in portal).
 */
export async function getCotalityAccessToken(
  args: GetCotalityAccessTokenArgs,
): Promise<string> {
  const { app, fetchImpl, signal, adapterKeyForLog } = args;
  const creds = readCotalityAppCredentials(app);
  if (!creds) {
    const keyVar =
      app === "property"
        ? "COTALITY_PROPERTY_KEY/SECRET"
        : "COTALITY_SPATIALTILE_KEY/SECRET";
    throw new AdapterRunError(
      "no-coverage",
      `${keyVar} is not configured on this deployment. Regrid remains the active national parcel/zoning provider.`,
    );
  }

  const now = Date.now();
  const cached = cotalityTokenCache.get(app);
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const inflight = cotalityTokenInflight.get(app);
  if (inflight) return inflight;

  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const tokenUrl = cotalityTokenUrl();

  const promise = (async (): Promise<string> => {
    cotalityLogEvent("info", "cotality oauth token start", adapterKeyForLog, {
      app,
      token_url: redactUrl(tokenUrl),
    });
    const startedAtMs = Date.now();

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

    let res: Response;
    try {
      res = await fetcher(tokenUrl, {
        method: "POST",
        signal,
        headers: {
          "User-Agent": COTALITY_USER_AGENT,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
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

    const tokenObj = json as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const accessToken =
      typeof tokenObj.access_token === "string"
        ? tokenObj.access_token
        : null;
    if (!accessToken) {
      throw new AdapterRunError(
        "parse-error",
        `Cotality OAuth token response missing access_token (${app} app).`,
      );
    }

    const expiresInSec =
      typeof tokenObj.expires_in === "number" && tokenObj.expires_in > 0
        ? tokenObj.expires_in
        : 3600;
    const expiresAt =
      Date.now() +
      expiresInSec * 1000 -
      COTALITY_TOKEN_EXPIRY_BUFFER_MS;

    cotalityTokenCache.set(app, { accessToken, expiresAt });
    cotalityLogEvent("info", "cotality oauth token ok", adapterKeyForLog, {
      app,
      duration_ms: Date.now() - startedAtMs,
      expires_in_sec: expiresInSec,
    });
    return accessToken;
  })();

  // Return the tracked wrapper (not the raw promise) so a .finally cleanup
  // handler does not leave the underlying rejection unhandled in Node 24+.
  const tracked = promise.finally(() => {
    const entry = cotalityTokenInflight.get(app);
    if (entry === tracked) cotalityTokenInflight.delete(app);
  });

  cotalityTokenInflight.set(app, tracked);
  return tracked;
}

// ---------------------------------------------------------------------------
// Upstream response shapes + normalization
// ---------------------------------------------------------------------------

export interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
  id?: string | number;
}

export interface CotalityPointResponse {
  clip?: string | number;
  parcel?: {
    geometry?: unknown;
    attributes?: Record<string, unknown>;
    [k: string]: unknown;
  };
  zoning?: {
    code?: string;
    description?: string;
    zoningType?: string;
    geometry?: unknown;
    [k: string]: unknown;
  };
  vintage?: string;
  county?: string;
  error?: string | { message?: string };
  [k: string]: unknown;
}

interface CotalityDedupEntry {
  promise: Promise<CotalityPointResponse>;
  expiresAt: number;
}

const cotalityPointDedup: Map<string, CotalityDedupEntry> = new Map();

function cotalityDedupKey(
  latitude: number,
  longitude: number,
  mode: "parcel" | "zoning",
): string {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  const lat = Math.round(latitude * factor) / factor;
  const lng = Math.round(longitude * factor) / factor;
  return `${mode}:${lat},${lng}`;
}

export function __resetCotalityDedupForTests(): void {
  cotalityPointDedup.clear();
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeGeometryToCoordinates(geom: unknown): unknown | null {
  if (!geom) return null;
  if (typeof geom === "object") {
    const g = geom as Record<string, unknown>;
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      if (Array.isArray(g.coordinates)) return g.coordinates;
    }
    if (Array.isArray(g.rings)) return g.rings;
    if (g.geometry) return normalizeGeometryToCoordinates(g.geometry);
    if (g.shape) return normalizeGeometryToCoordinates(g.shape);
  }
  if (typeof geom === "string") {
    const s = geom.trim().toUpperCase();
    if (s.startsWith("POLYGON") || s.startsWith("MULTIPOLYGON")) {
      return null;
    }
  }
  return null;
}

function snapshotDateFromResponse(resp: CotalityPointResponse): string {
  const candidates = [
    resp.vintage,
    (resp as Record<string, unknown>).lastUpdated,
    (resp as Record<string, unknown>).asOf,
    (resp as Record<string, unknown>).refreshDate,
    (resp as Record<string, unknown>).taxYear
      ? `${(resp as Record<string, unknown>).taxYear}-01-01`
      : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return nowIso();
}

function providerLabelFromResponse(resp: CotalityPointResponse): string {
  if (resp.county && typeof resp.county === "string" && resp.county.length > 0) {
    return `${COTALITY_PROVIDER_LABEL} (via ${resp.county})`;
  }
  return COTALITY_PROVIDER_LABEL;
}

function buildFeature(
  geometry: unknown,
  baseProps: Record<string, unknown>,
): NormalizedFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: geometry,
    } as NormalizedFeature["geometry"],
    properties: { ...baseProps },
  };
}

/** Defensively merge Property API + Spatial Tile payloads into one point response. */
export function mergeCotalityPropertyAndSpatial(
  propertyJson: unknown,
  spatialJson: unknown | null,
): CotalityPointResponse {
  const property =
    propertyJson && typeof propertyJson === "object"
      ? (propertyJson as CotalityPointResponse)
      : ({} as CotalityPointResponse);

  if (!spatialJson || typeof spatialJson !== "object") {
    return property;
  }

  const spatial = spatialJson as Record<string, unknown>;
  const spatialGeom =
    spatial.geometry ??
    (spatial.parcel as Record<string, unknown> | undefined)?.geometry ??
    spatial;

  const parcel = property.parcel ?? { attributes: {} };
  property.parcel = {
    ...parcel,
    geometry: spatialGeom,
  };
  return property;
}

interface FetchCotalityPointArgs {
  latitude: number;
  longitude: number;
  address?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  timeoutMs: number;
  /** parcel adapter requires SpatialTile creds + geometry fetch; zoning is property-only. */
  mode: "parcel" | "zoning";
}

async function fetchCotalityJson(args: {
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
    if (res.status === 401 || res.status === 403) {
      throw new AdapterRunError(
        "upstream-error",
        `Cotality ${label} responded HTTP ${res.status}. Check demo-app KEY/SECRET and token entitlement.${
          bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
        }`,
      );
    }
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

async function getOrFetchCotalityPoint(
  args: FetchCotalityPointArgs,
): Promise<CotalityPointResponse> {
  const {
    latitude,
    longitude,
    address,
    fetchImpl,
    signal,
    adapterKeyForLog,
    mode,
  } = args;

  const dedupKey = cotalityDedupKey(latitude, longitude, mode);
  const now = Date.now();
  const existing = cotalityPointDedup.get(dedupKey);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }

  // Gate before any network (token or API).
  if (!readCotalityAppCredentials("property")) {
    throw new AdapterRunError(
      "no-coverage",
      "COTALITY_PROPERTY_KEY/SECRET is not configured. Regrid remains the active national parcel/zoning provider for this deployment.",
    );
  }
  if (mode === "parcel" && !readCotalityAppCredentials("spatialtile")) {
    throw new AdapterRunError(
      "no-coverage",
      "COTALITY_SPATIALTILE_KEY/SECRET is not configured. Cotality parcel geometry requires the SpatialTile demo app; Regrid remains the fallback.",
    );
  }

  const fetcher: typeof fetch = fetchImpl ?? fetch;

  const promise = (async (): Promise<CotalityPointResponse> => {
    const propertyToken = await getCotalityAccessToken({
      app: "property",
      fetchImpl: fetcher,
      signal,
      adapterKeyForLog,
    });

    const propertyBase = cotalityPropertyBaseUrl().replace(/\/$/, "");
    const propertyPath = cotalityPropertyPointPath();
    const propertyUrl = new URL(`${propertyBase}${propertyPath}`);
    propertyUrl.searchParams.set("lat", String(latitude));
    propertyUrl.searchParams.set("lon", String(longitude));
    if (address) propertyUrl.searchParams.set("address", address);

    const propertyJson = await fetchCotalityJson({
      url: propertyUrl.toString(),
      bearerToken: propertyToken,
      fetchImpl: fetcher,
      signal,
      adapterKeyForLog,
      label: "property",
    });

    let spatialJson: unknown | null = null;
    if (mode === "parcel") {
      const spatialToken = await getCotalityAccessToken({
        app: "spatialtile",
        fetchImpl: fetcher,
        signal,
        adapterKeyForLog,
      });
      const spatialBase = cotalitySpatialTileBaseUrl().replace(/\/$/, "");
      const spatialPath = cotalitySpatialTilePointPath();
      const spatialUrl = new URL(`${spatialBase}${spatialPath}`);
      spatialUrl.searchParams.set("lat", String(latitude));
      spatialUrl.searchParams.set("lon", String(longitude));
      if (address) spatialUrl.searchParams.set("address", address);

      spatialJson = await fetchCotalityJson({
        url: spatialUrl.toString(),
        bearerToken: spatialToken,
        fetchImpl: fetcher,
        signal,
        adapterKeyForLog,
        label: "spatialtile",
      });
    }

    const merged = mergeCotalityPropertyAndSpatial(propertyJson, spatialJson);
    cotalityLogEvent("info", "cotality request ok", adapterKeyForLog, {
      mode,
      has_clip: !!merged.clip,
      has_parcel_geom: !!merged.parcel?.geometry,
      has_zoning: !!merged.zoning,
    });
    return merged;
  })();

  cotalityPointDedup.set(dedupKey, {
    promise,
    expiresAt: now + COTALITY_INMEM_TTL_MS,
  });
  promise.catch(() => {
    const entry = cotalityPointDedup.get(dedupKey);
    if (entry && entry.promise === promise) {
      cotalityPointDedup.delete(dedupKey);
    }
  });
  return promise;
}

function cotalityApplies(ctx: AdapterContext): boolean {
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

export const cotalityParcelsAdapter: Adapter = {
  adapterKey: "cotality:parcels",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-parcel",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const response = await getOrFetchCotalityPoint({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      timeoutMs: COTALITY_TIMEOUT_MS,
      mode: "parcel",
    });

    const parcelGeom = response.parcel?.geometry ?? null;
    const coords = normalizeGeometryToCoordinates(parcelGeom);
    if (!coords) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality returned no parcel polygon at this lat/lng (SpatialTile geometry missing or unrecognized shape).",
      );
    }

    const clip =
      response.clip ??
      (response.parcel?.attributes as Record<string, unknown> | undefined)
        ?.clip ??
      null;
    const feature = buildFeature(coords, {
      clip,
      source: "cotality",
      ...(response.parcel?.attributes ?? {}),
    });

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabelFromResponse(response),
      snapshotDate: snapshotDateFromResponse(response),
      payload: { kind: "parcel", parcel: feature },
    };
  },
};

export const cotalityZoningAdapter: Adapter = {
  adapterKey: "cotality:zoning",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-zoning",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const response = await getOrFetchCotalityPoint({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      timeoutMs: COTALITY_TIMEOUT_MS,
      mode: "zoning",
    });

    const zoningBlock =
      response.zoning ??
      (response.parcel?.attributes as Record<string, unknown> | undefined)
        ?.zoning ??
      null;
    let zoningGeom: unknown = null;
    let zoningProps: Record<string, unknown> = {};

    if (zoningBlock && typeof zoningBlock === "object") {
      const zb = zoningBlock as Record<string, unknown>;
      zoningGeom = zb.geometry ?? zb;
      zoningProps = {
        zoning: zb.code ?? zb.zoning ?? zb.zoningCode ?? null,
        zoning_description: zb.description ?? zb.zoningDescription ?? null,
        zoning_type: zb.zoningType ?? null,
        ...zb,
      };
    } else if (response.parcel?.attributes) {
      const attrs = response.parcel.attributes as Record<string, unknown>;
      if (attrs.zoning || attrs.zoning_code || attrs.zoningCode) {
        zoningProps = {
          zoning: attrs.zoning ?? attrs.zoning_code ?? attrs.zoningCode,
          zoning_description:
            attrs.zoning_description ?? attrs.zoningDescription,
          zoning_type: attrs.zoning_type ?? attrs.zoningType,
        };
        zoningGeom = response.parcel.geometry;
      }
    }

    const coords = normalizeGeometryToCoordinates(zoningGeom);
    if (!coords && Object.keys(zoningProps).length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality returned no zoning record at this lat/lng (Property API response did not include zoning fields).",
      );
    }

    const parcelAttrs = (response.parcel?.attributes ?? {}) as Record<
      string,
      unknown
    >;
    const clip = response.clip ?? parcelAttrs.clip ?? null;
    const feature = buildFeature(
      coords ?? normalizeGeometryToCoordinates(response.parcel?.geometry) ?? [],
      { clip, source: "cotality", ...zoningProps },
    );

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabelFromResponse(response),
      snapshotDate: snapshotDateFromResponse(response),
      payload: { kind: "zoning", zoning: feature },
    };
  },
};
