/**
 * Cotality (CoreLogic) — national parcel + zoning adapter pair.
 *
 * Per 2026-06-06 decision (`_decisions/2026-06-06_cotality_parcel_provider.md`):
 * Cotality is the launch provider for parcel/zoning on Property Brief /
 * Cortex. Regrid remains the interim/dev fallback and stays registered so
 * both apps remain testable end-to-end while the Cotality eval (self-serve
 * 30-day trial) and later MCP production path land.
 *
 * This adapter emits the **identical** `siteContext.layers[]` / `payload`
 * contract as the Regrid adapter (`regrid:parcels` / `regrid:zoning`):
 *   - `payload.parcel` = GeoJSON Feature with `geometry: { type: "Polygon" | "MultiPolygon" }`
 *   - `payload.zoning` = GeoJSON Feature (geometry may be the parcel polygon
 *     when Cotality returns zoning as attributes on the parcel record)
 * Consumers (`overlays.ts`, briefing engine, `brokerageSiteContext.ts`)
 * are unchanged.
 *
 * Two adapters, one upstream call (in-memory 15 min dedup, same pattern as
 * Regrid SCOPE B). CLIP is carried as the stable parcel identifier (Regrid
 * `ll_uuid` analog) per the place-graph strategy.
 *
 * Key gate (no hard failure):
 *   - When `COTALITY_API_KEY` is absent, the adapters surface `no-coverage`
 *     (neutral pill) with a diagnostic message and do **not** call upstream.
 *     Regrid (also registered) supplies data (or its own no-coverage).
 *   - Live calls are only attempted when the key is present (trial or
 *     production entitlement). 30-day trial per developer.corelogic.com
 *     (100 property-data calls/day + 25 AVM/day as of 2026-06-06).
 *
 * Endpoint note: The exact host/path + auth shape for the self-serve trial
 * "property-data" lane (Property Characteristics / Parcel / Zoning with
 * geometry) is obtained after signup at https://developer.corelogic.com.
 * The recon (`_research/2026-05-30_cotality_property_brief_recon.md` §2b, §3,
 * §4) distinguishes the assessor-grade lane (this adapter) from Trestle MLS
 * OData (listings only, no guaranteed polygon for off-market). Update the
 * constants + request builder from the authenticated portal docs / MCP tool
 * schema when available. The adapter defensively normalizes common geometry
 * representations (GeoJSON, Esri rings, WKT-ish) to the required payload.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { CACHE_COORDINATE_PRECISION } from "../cache";

const COTALITY_PROVIDER_LABEL = "Cotality";

/**
 * In-memory dedup TTL (ms). Matches Regrid and fcc:broadband.
 */
const COTALITY_INMEM_TTL_MS = 15 * 60 * 1000;

/**
 * Default per-adapter timeout floor (ms). Conservative-with-headroom for
 * a commercial property-data endpoint; smaller than county-GIS slow feeds.
 */
const COTALITY_TIMEOUT_MS = 30_000;

/** Identifying UA. Same convention as sibling adapters. */
const COTALITY_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

/**
 * Freshness window (months). Cotality is positioned as fresher than Regrid
 * (assessor-direct vs resold). 6 months is conservative; adjust per the
 * vintage/refresh fields returned by the trial tier.
 */
export const COTALITY_FRESHNESS_THRESHOLD_MONTHS = 6;

/**
 * Structured logging (same shape as regridLogEvent for log-explorer parity).
 */
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

function redactKey(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("apikey")) {
      u.searchParams.set("apikey", "<redacted>");
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** GeoJSON Feature we normalize every successful response into. */
export interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
  id?: string | number;
}

/** Shape we return from the shared fetch (before splitting to parcel vs zoning). */
export interface CotalityPointResponse {
  clip?: string | number;
  parcel?: {
    geometry?: unknown; // GeoJSON | Esri rings | { wkt?: string } etc.
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
  vintage?: string; // or lastUpdated, asOf, taxYear, etc.
  county?: string;
  error?: string | { message?: string };
  [k: string]: unknown;
}

interface CotalityDedupEntry {
  promise: Promise<CotalityPointResponse>;
  expiresAt: number;
}

const cotalityDedup: Map<string, CotalityDedupEntry> = new Map();

function cotalityDedupKey(latitude: number, longitude: number): string {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  const lat = Math.round(latitude * factor) / factor;
  const lng = Math.round(longitude * factor) / factor;
  return `${lat},${lng}`;
}

/** Test-only reset (mirrors Regrid). */
export function __resetCotalityDedupForTests(): void {
  cotalityDedup.clear();
}

function nowIso(): string {
  return new Date().toISOString();
}

function readApiKeyOrNull(): string | null {
  const key = process.env.COTALITY_API_KEY;
  if (!key || key.length === 0) return null;
  return key;
}

/**
 * Best-effort normalizer: accepts a variety of geometry payloads from
 * Cotality trial responses and returns a GeoJSON Polygon/MultiPolygon
 * coordinate array (or null). Handles:
 *   - GeoJSON { type: "Polygon", coordinates: [...] }
 *   - Esri { rings: [...] } (wkid 4326 or 102100 assumed)
 *   - WKT-ish strings starting with POLYGON(
 * The caller wraps the result into a Feature with properties.
 */
function normalizeGeometryToCoordinates(geom: unknown): unknown | null {
  if (!geom) return null;
  if (typeof geom === "object") {
    const g = geom as Record<string, unknown>;
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      if (Array.isArray(g.coordinates)) return g.coordinates;
    }
    if (Array.isArray(g.rings)) {
      // Treat as GeoJSON-style rings (already [ [lng,lat], ... ])
      return g.rings;
    }
    // Some responses nest geometry under "geometry" or "shape"
    if (g.geometry) return normalizeGeometryToCoordinates(g.geometry);
    if (g.shape) return normalizeGeometryToCoordinates(g.shape);
  }
  if (typeof geom === "string") {
    const s = geom.trim().toUpperCase();
    if (s.startsWith("POLYGON") || s.startsWith("MULTIPOLYGON")) {
      // Very light WKT → coordinates is not trivial without a parser.
      // For the scaffold we surface the raw WKT in properties and
      // let a later pass (or a small client-side util) parse if needed.
      // The contract wants GeoJSON coordinates for overlays; if we hit
      // this path on a real trial response we will extend the normalizer.
      return null;
    }
  }
  return null;
}

function snapshotDateFromResponse(resp: CotalityPointResponse): string {
  const candidates = [
    resp.vintage,
    (resp as any).lastUpdated,
    (resp as any).asOf,
    (resp as any).refreshDate,
    (resp as any).taxYear ? `${resp.taxYear}-01-01` : undefined,
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
      type: "Polygon", // overlays.ts also handles MultiPolygon via the geojson extractor
      coordinates: geometry,
    } as any,
    properties: { ...baseProps },
  };
}

interface FetchCotalityArgs {
  latitude: number;
  longitude: number;
  address?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  timeoutMs: number;
}

async function getOrFetchCotalityPoint(
  args: FetchCotalityArgs,
): Promise<CotalityPointResponse> {
  const {
    latitude,
    longitude,
    address,
    fetchImpl,
    signal,
    adapterKeyForLog,
    timeoutMs,
  } = args;

  const key = cotalityDedupKey(latitude, longitude);
  const now = Date.now();
  const existing = cotalityDedup.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }

  const apiKey = readApiKeyOrNull();
  if (!apiKey) {
    // No key: surface as no-coverage (clean fallback to Regrid). Do not
    // throw upstream-error — the caller (run) treats missing key as
    // "this provider not configured on this deployment".
    throw new AdapterRunError(
      "no-coverage",
      "COTALITY_API_KEY is not configured. Regrid remains the active national parcel/zoning provider for this deployment.",
    );
  }

  // Endpoint + query shape are provisional — replace from the authenticated
  // developer.corelogic.com trial portal docs after 2026-06-06 signup.
  // The recon expects Lane A (Property Characteristics / Parcel / Zoning)
  // with CLIP + geometry for arbitrary addresses (not only MLS listings).
  const url = new URL(
    process.env.COTALITY_PARCEL_ENDPOINT ||
      "https://api.corelogic.com/propertycharacteristics/v1/point",
  );
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  if (address) url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);
  const urlString = url.toString();
  const fetcher: typeof fetch = fetchImpl ?? fetch;

  cotalityLogEvent("info", "cotality request start", adapterKeyForLog, {
    url: redactKey(urlString),
    lat: latitude,
    lng: longitude,
    has_address: !!address,
    timeout_ms: timeoutMs,
  });
  const startedAtMs = Date.now();

  const promise = (async (): Promise<CotalityPointResponse> => {
    let res: Response;
    try {
      res = await fetcher(urlString, {
        signal,
        headers: {
          "User-Agent": COTALITY_USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const throwExcerpt =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
        error_class: "network",
        duration_ms: durationMs,
        throw_excerpt: throwExcerpt,
      });
      throw new AdapterRunError(
        "network-error",
        `Cotality did not get a response. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
      );
    }

    if (!res.ok) {
      const durationMs = Date.now() - startedAtMs;
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await res.text()).slice(0, 256);
      } catch {
        /* swallow */
      }
      cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
        error_class: "status",
        http_status: res.status,
        duration_ms: durationMs,
        body_excerpt: bodyExcerpt,
      });
      // 401/403 on a mounted key is a real misconfig — surface hard so operator notices.
      if (res.status === 401 || res.status === 403) {
        throw new AdapterRunError(
          "upstream-error",
          `Cotality responded with HTTP ${res.status}. Check COTALITY_API_KEY entitlement and trial status.${
            bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
          }`,
        );
      }
      throw new AdapterRunError(
        "upstream-error",
        `Cotality responded with HTTP ${res.status}.${
          bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
        } Use Force refresh to retry.`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const message = err instanceof Error ? err.message : String(err);
      cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
        error_class: "parse",
        duration_ms: durationMs,
        parse_error: message,
      });
      throw new AdapterRunError(
        "parse-error",
        `Cotality response was not JSON: ${message}`,
      );
    }

    if (!json || typeof json !== "object") {
      throw new AdapterRunError(
        "parse-error",
        "Cotality response was not a JSON object.",
      );
    }

    const response = json as CotalityPointResponse;
    const durationMs = Date.now() - startedAtMs;
    cotalityLogEvent("info", "cotality request ok", adapterKeyForLog, {
      duration_ms: durationMs,
      has_clip: !!response.clip,
      has_parcel_geom: !!response.parcel?.geometry,
      has_zoning: !!response.zoning,
    });
    return response;
  })();

  cotalityDedup.set(key, { promise, expiresAt: now + COTALITY_INMEM_TTL_MS });
  promise.catch(() => {
    const entry = cotalityDedup.get(key);
    if (entry && entry.promise === promise) {
      cotalityDedup.delete(key);
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

/**
 * `cotality:parcels` — parcel polygon + attributes (CLIP as stable id).
 */
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
    });

    // If we reached here with a response but no parcel geometry, treat as
    // no-coverage (Cotality may have a record but no boundary for this point).
    const parcelGeom = response.parcel?.geometry ?? null;
    const coords = normalizeGeometryToCoordinates(parcelGeom);
    if (!coords) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality returned no parcel polygon at this lat/lng (or the trial tier response shape did not include a recognized geometry).",
      );
    }

    const clip = response.clip ?? (response.parcel as any)?.attributes?.clip ?? null;
    const baseProps: Record<string, unknown> = {
      clip,
      source: "cotality",
      ...(response.parcel?.attributes ?? {}),
    };
    const feature = buildFeature(coords, baseProps);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabelFromResponse(response),
      snapshotDate: snapshotDateFromResponse(response),
      payload: {
        kind: "parcel",
        parcel: feature,
      },
    };
  },
};

/**
 * `cotality:zoning` — zoning attributes (and geometry when provided).
 * Emits no-coverage when Cotality has a parcel but no zoning record/attrs,
 * without failing the parcel adapter (same contract as Regrid).
 */
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
    });

    // Zoning may be delivered as a top-level block or as attributes on the
    // parcel record. Prefer an explicit zoning geometry when present.
    const zoningBlock = response.zoning ?? (response.parcel as any)?.attributes?.zoning ?? null;
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
      // Fallback: zoning fields may be flattened on the parcel attributes.
      const attrs = response.parcel.attributes as Record<string, unknown>;
      if (attrs.zoning || attrs.zoning_code || attrs.zoningCode) {
        zoningProps = {
          zoning: attrs.zoning ?? attrs.zoning_code ?? attrs.zoningCode,
          zoning_description: attrs.zoning_description ?? attrs.zoningDescription,
          zoning_type: attrs.zoning_type ?? attrs.zoningType,
        };
        // Use parcel geometry for the zoning feature (common when zoning is attr-only).
        zoningGeom = response.parcel.geometry;
      }
    }

    const coords = normalizeGeometryToCoordinates(zoningGeom);
    if (!coords && Object.keys(zoningProps).length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality returned no zoning record at this lat/lng (the parcel may sit in an unzoned tract or the trial tier response did not include zoning for this record).",
      );
    }

    const parcelAttrs = (response.parcel?.attributes ?? {}) as Record<string, unknown>;
    const clip = response.clip ?? parcelAttrs.clip ?? null;
    const baseProps: Record<string, unknown> = {
      clip,
      source: "cotality",
      ...zoningProps,
    };
    const feature = buildFeature(coords ?? normalizeGeometryToCoordinates(response.parcel?.geometry) ?? [], baseProps);

    const snapshotDate =
      response.vintage || (response as any).lastUpdated
        ? snapshotDateFromResponse(response)
        : nowIso();

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabelFromResponse(response),
      snapshotDate,
      payload: {
        kind: "zoning",
        zoning: feature,
      },
    };
  },
};
