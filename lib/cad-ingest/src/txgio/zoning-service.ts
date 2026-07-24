/**
 * Public zoning-layer ArcGIS REST client for the parcel zoning stamp.
 *
 * Fetches a city's zoning polygon layer (config in `zoning-layers.ts`) as
 * ArcGIS JSON in WGS84 (`outSR=4326`, `f=json`) and converts `rings` to
 * GeoJSON Polygon so the polygons share the coordinate frame of the stored
 * parcels (`txgio_parcel` geometry is WGS84). Prefer json over geojson:
 * some hosts (Killeen MapServer) 400 mid-layer on `f=geojson` while json
 * succeeds. Paged by `resultOffset`/`resultRecordCount`, exit-bounded.
 *
 * Egress note: some public ArcGIS hosts sit behind a TLS setup whose OCSP/
 * CRL endpoint is unreachable from a sandboxed runner; the CLI is run with
 * the sandbox relaxed for this fetch (the reader here just uses global
 * fetch and is fully injectable for tests).
 */

import type { GeoJsonGeometry } from "./geo";
import type { ZoningLayerConfig } from "./zoning-layers";

/** Server page size cap; ArcGIS commonly maxes at 2000. */
export const ZONING_PAGE_SIZE = 2000;
/** Polite delay between pages. */
export const ZONING_RATE_MS = 300;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as Record<string, unknown>;
  const err = body.error as { code?: number; message?: string } | undefined;
  if (err) {
    throw new Error(`ArcGIS ${err.code ?? "?"}: ${err.message ?? "error"}`);
  }
  return body;
};

/**
 * Convert an ArcGIS REST polygon (`geometry.rings`) to GeoJSON Polygon.
 * Prefer `f=json` over `f=geojson` for paging: some MapServers (Killeen)
 * 400 on geojson past mid-layer offsets while json+rings succeeds.
 */
export function esriRingsToGeoJson(geometry: unknown): GeoJsonGeometry | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as {
    type?: string;
    coordinates?: unknown;
    rings?: unknown;
  };
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    return g as GeoJsonGeometry;
  }
  if (!Array.isArray(g.rings) || g.rings.length === 0) return null;
  return { type: "Polygon", coordinates: g.rings };
}

/** Normalize a GeoJSON Feature or ArcGIS json feature for reduceZoningFeature. */
export function normalizeZoningPageFeature(feature: unknown): {
  properties: Record<string, unknown>;
  geometry: GeoJsonGeometry | null;
} {
  const f = feature as {
    properties?: Record<string, unknown> | null;
    attributes?: Record<string, unknown> | null;
    geometry?: unknown;
  };
  const properties = (f.properties ?? f.attributes ?? {}) as Record<
    string,
    unknown
  >;
  return {
    properties,
    geometry: esriRingsToGeoJson(f.geometry),
  };
}

/** One raw zoning feature reduced to (code, description, geometry). */
export interface RawZoningFeature {
  code: string | null;
  description: string | null;
  geometry: GeoJsonGeometry | null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Apply an optional `codeExtractRegex` to a raw code value. When the config
 * carries no regex, the raw value passes through unchanged (Georgetown path).
 * When it does, the value is matched against `new RegExp(codeExtractRegex)`
 * and capture group 1 is returned RAW (still no further transform — the
 * leading-token normalization in districtMapping does the alignment). If the
 * regex does not match, or its group 1 is empty, the code is NULL — honest,
 * never a guessed district.
 */
function extractCode(raw: string | null, regex?: string): string | null {
  if (raw === null) return null;
  if (!regex) return raw;
  const m = new RegExp(regex).exec(raw);
  return str(m?.[1] ?? null);
}

/**
 * Reduce a GeoJSON Feature from the zoning layer to the fields the stamp
 * needs. `codeField`/`descriptionField`/`codeExtractRegex` come from the
 * layer config.
 */
function isNullDistrictCode(
  code: string | null,
  nullCodes: string[] | undefined,
): boolean {
  if (!code || !nullCodes || nullCodes.length === 0) return false;
  const upper = code.trim().toUpperCase();
  return nullCodes.some((c) => c.trim().toUpperCase() === upper);
}

export function reduceZoningFeature(
  feature: unknown,
  cfg: Pick<
    ZoningLayerConfig,
    | "codeField"
    | "descriptionField"
    | "codeExtractRegex"
    | "nullDistrictCodes"
  >,
): RawZoningFeature {
  const { properties: props, geometry } = normalizeZoningPageFeature(feature);
  const code = extractCode(str(props[cfg.codeField]), cfg.codeExtractRegex);
  return {
    code: isNullDistrictCode(code, cfg.nullDistrictCodes) ? null : code,
    description: cfg.descriptionField ? str(props[cfg.descriptionField]) : null,
    geometry,
  };
}

export interface ZoningFetchOptions {
  cfg: ZoningLayerConfig;
  /** Override fetch-json (tests). */
  fetchJson?: FetchJson;
  /** Delay between pages, ms. */
  rateMs?: number;
  /** Cap features fetched (bounded sample runs). */
  limit?: number;
  onPage?: (info: { offset: number; got: number; total: number }) => void;
}

/**
 * Fetch ALL zoning features for a city into a flat array of reduced
 * features (code/description/geometry). Paged + exit-bounded. The caller
 * feeds this to `buildZoningIndex`.
 */
/**
 * Resolve the per-request page size from the layer's `maxRecordCount`.
 * Asking above the server cap both under-fetches (silent truncate) and can
 * 400 on later offsets (Killeen MapServer at offset 5000 with want=2000).
 */
async function resolveZoningPageSize(
  layerUrl: string,
  fetchJson: FetchJson,
): Promise<number> {
  try {
    const meta = (await fetchJson(`${layerUrl}?f=json`)) as {
      maxRecordCount?: unknown;
    };
    const max = meta.maxRecordCount;
    if (typeof max === "number" && Number.isFinite(max) && max > 0) {
      return Math.min(ZONING_PAGE_SIZE, Math.floor(max));
    }
  } catch {
    // Fall through to default — paging loop still handles full-page continue.
  }
  return ZONING_PAGE_SIZE;
}

export async function fetchZoningFeatures(
  opts: ZoningFetchOptions,
): Promise<RawZoningFeature[]> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const rateMs = opts.rateMs ?? ZONING_RATE_MS;
  const base = opts.cfg.layerUrl.replace(/\/+$/, "");
  const out: RawZoningFeature[] = [];
  let pageSize = await resolveZoningPageSize(base, fetchJson);

  let offset = 0;
  for (;;) {
    const remaining =
      opts.limit !== undefined ? opts.limit - out.length : pageSize;
    if (remaining <= 0) return out;
    const want = Math.min(pageSize, remaining);
    const outFields = [opts.cfg.codeField, opts.cfg.descriptionField]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(",");
    const where = opts.cfg.layerWhere?.trim() || "1=1";
    const url =
      `${base}/query?where=${encodeURIComponent(where)}` +
      `&outFields=${encodeURIComponent(outFields)}` +
      `&resultOffset=${offset}&resultRecordCount=${want}` +
      `&returnGeometry=true&outSR=4326&f=json`;
    const page = (await fetchJson(url)) as {
      features?: unknown[];
      exceededTransferLimit?: boolean;
    };
    const feats = Array.isArray(page.features) ? page.features : [];
    for (const f of feats) {
      out.push(reduceZoningFeature(f, opts.cfg));
      if (opts.limit !== undefined && out.length >= opts.limit) {
        opts.onPage?.({ offset, got: feats.length, total: out.length });
        return out;
      }
    }
    opts.onPage?.({ offset, got: feats.length, total: out.length });
    // ArcGIS paging contract (observed live 2026-07-24):
    // 1) Hosts omit `exceededTransferLimit` on a full page (Austin / SA) —
    //    continue while feats.length >= want (want already capped to
    //    maxRecordCount when the layer publishes one).
    // 2) Asking above maxRecordCount can 400 on later offsets (Killeen) —
    //    resolveZoningPageSize prevents that; adaptive shrink is backup.
    // 3) Prefer f=json: Killeen geojson 400s past offset ~5000 with
    //    resultRecordCount>100 while json+rings returns the rest.
    if (feats.length === 0) return out;
    offset += feats.length;
    if (feats.length < want && page.exceededTransferLimit === true) {
      pageSize = feats.length;
    }
    const morePages =
      page.exceededTransferLimit === true || feats.length >= want;
    if (!morePages) return out;
    await sleep(rateMs);
  }
}
