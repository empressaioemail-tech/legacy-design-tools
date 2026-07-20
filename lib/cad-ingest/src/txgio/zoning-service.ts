/**
 * Public zoning-layer ArcGIS REST client for the parcel zoning stamp.
 *
 * Fetches a city's zoning polygon layer (config in `zoning-layers.ts`) as
 * GeoJSON in WGS84 (`outSR=4326`, `f=geojson`) so the polygons share the
 * coordinate frame of the stored parcels (`txgio_parcel` geometry is WGS84).
 * Paged by `resultOffset`/`resultRecordCount` (same shape as the address
 * service), exit-bounded: RETURNS when the server stops paging. The zoning
 * layer is small (Georgetown ~1,888 polygons), so this is a couple of pages
 * fetched ONCE into the in-memory index, never per parcel.
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
export function reduceZoningFeature(
  feature: unknown,
  cfg: Pick<
    ZoningLayerConfig,
    "codeField" | "descriptionField" | "codeExtractRegex"
  >,
): RawZoningFeature {
  const f = feature as {
    properties?: Record<string, unknown> | null;
    geometry?: GeoJsonGeometry | null;
  };
  const props = f?.properties ?? {};
  return {
    code: extractCode(str(props[cfg.codeField]), cfg.codeExtractRegex),
    description: cfg.descriptionField ? str(props[cfg.descriptionField]) : null,
    geometry: f?.geometry ?? null,
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
export async function fetchZoningFeatures(
  opts: ZoningFetchOptions,
): Promise<RawZoningFeature[]> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const rateMs = opts.rateMs ?? ZONING_RATE_MS;
  const base = opts.cfg.layerUrl.replace(/\/+$/, "");
  const out: RawZoningFeature[] = [];

  let offset = 0;
  for (;;) {
    const remaining =
      opts.limit !== undefined ? opts.limit - out.length : ZONING_PAGE_SIZE;
    if (remaining <= 0) return out;
    const want = Math.min(ZONING_PAGE_SIZE, remaining);
    const outFields = [opts.cfg.codeField, opts.cfg.descriptionField]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(",");
    const url =
      `${base}/query?where=1%3D1` +
      `&outFields=${encodeURIComponent(outFields)}` +
      `&resultOffset=${offset}&resultRecordCount=${want}` +
      `&returnGeometry=true&outSR=4326&f=geojson`;
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
    if (feats.length < want || page.exceededTransferLimit !== true) return out;
    offset += feats.length;
    await sleep(rateMs);
  }
}
