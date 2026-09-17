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
 *
 * Frame and vintage (P-259): the requested frame is `outSR=4326` and the
 * RESPONSE is verified against the WGS84 degree bounds on every page
 * (`assertWgs84Frame`) — Austin's layer is published in state-plane feet, so a
 * host that ignored the parameter would otherwise have degrees point-in-
 * polygon'd against feet and report a clean 0%, indistinguishable from an
 * unzoned city. The layer's own `spatialReference` and
 * `editingInfo.lastEditDate` are read at source and handed to the caller
 * through `onMeta`: a vintage that is read, never inferred from the source's
 * kind (most-current-source ruling, 2026-09-11).
 */

import type { GeoJsonGeometry } from "./geo";
import { bboxOfGeometry, isPlausibleTexasWgs84Bbox } from "./geo";
import type { BaseCodeParse } from "./zoning-base-code";
import { parseBaseCode } from "./zoning-base-code";
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
  /**
   * OPTIONAL (P-259). Set only when the layer config carries `baseCodeParse`:
   * the full parse of the published value — kind, base, overlays and the
   * reason. Absent for every other layer, where absent means "the published
   * value IS the district" (the Georgetown/Austin-old contract). It travels
   * with the polygon all the way into the stamp summary so overlays a later
   * ruling may need are never discarded at the layer boundary.
   */
  parse?: BaseCodeParse;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Coerce a zoning codeField value to a non-empty string. ArcGIS coded-domain
 * fields arrive as small integers (Bastrop ZoneTypeClass=3); string fields
 * (Georgetown ZONE) stay strings. Non-finite numbers / other types → null.
 */
function codeFieldRaw(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
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
 * Decode ArcGIS coded-domain ints (etc.) via `codeDomainMap`. When the map is
 * present, unmapped values become NULL — never stamp a bare `"3"` that the
 * setback router cannot match as `"SF-1"`.
 */
function applyCodeDomainMap(
  raw: string | null,
  map: Record<string, string> | undefined,
): string | null {
  if (raw === null) return null;
  if (!map) return raw;
  const mapped = map[raw];
  if (typeof mapped !== "string") return null;
  const t = mapped.trim();
  return t.length > 0 ? t : null;
}

/**
 * Reduce a GeoJSON Feature from the zoning layer to the fields the stamp
 * needs. `codeField`/`descriptionField`/`codeExtractRegex`/`codeDomainMap`
 * come from the layer config.
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
    | "codeDomainMap"
    | "nullDistrictCodes"
    | "baseCodeParse"
  >,
): RawZoningFeature {
  const { properties: props, geometry } = normalizeZoningPageFeature(feature);
  const decoded = applyCodeDomainMap(
    codeFieldRaw(props[cfg.codeField]),
    cfg.codeDomainMap,
  );
  const code = extractCode(decoded, cfg.codeExtractRegex);
  const description = cfg.descriptionField
    ? str(props[cfg.descriptionField])
    : null;
  if (isNullDistrictCode(code, cfg.nullDistrictCodes)) {
    return { code: null, description, geometry };
  }
  if (!cfg.baseCodeParse || code === null) {
    return { code, description, geometry };
  }
  // Base-code layers (Austin): resolve the compound published value to its
  // base district. `unrecognised` keeps the RAW value in `code` — the published
  // value is stamped verbatim (never a truncated prefix; see
  // `ZoningPolygon.parse`), and the polygon stays in the PIP index so a parcel
  // inside it is not miscounted as "outside the city". `planned-development`
  // keeps the raw value too, which is what makes A-164's PUD message fire on it
  // exactly as it did before this parser existed. An INTERIM value
  // (`parse.interim`, P-259b) resolves to its base district and carries the flag
  // on the parse; the flag, not this function, decides what the stamp writes.
  const parse = parseBaseCode(code, cfg.baseCodeParse);
  return {
    code: parse.kind === "base" ? (parse.base ?? code) : code,
    description,
    geometry,
    parse,
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
  /**
   * Called once, before the first page, with what the layer says about
   * itself (source spatial reference, vintage). Purely observational: a host
   * that publishes no metadata yields nulls, and the fetch still runs.
   */
  onMeta?: (meta: ZoningLayerMeta) => void;
}

/**
 * What a layer publishes about itself — READ AT SOURCE, never assumed.
 *
 * The projection is the reason this exists: Austin's layer is state-plane
 * FEET (wkid 102739 / latestWkid 2277) while `txgio_parcel` geometry is WGS84
 * degrees, so `outSR=4326` is requested on every page and the response frame
 * is verified (see {@link assertWgs84Frame}). `lastEditDate` is the layer
 * vintage the most-current-source ruling requires be read from the source
 * itself rather than inferred from the source's kind.
 */
export interface ZoningLayerMeta {
  /** Layer name as published. */
  name: string | null;
  /** Publisher's own spatial reference wkid (Austin: 102739). */
  sourceWkid: number | null;
  /** Publisher's `latestWkid` (Austin: 2277 = TX Central state plane feet). */
  sourceLatestWkid: number | null;
  /** `editingInfo.lastEditDate` as an ISO string — the layer's vintage. */
  lastEditDate: string | null;
  /** Server page cap as published. */
  maxRecordCount: number | null;
  /** True when the layer metadata could not be read (fields stay null). */
  unavailable: boolean;
}

const EMPTY_META: ZoningLayerMeta = {
  name: null,
  sourceWkid: null,
  sourceLatestWkid: null,
  lastEditDate: null,
  maxRecordCount: null,
  unavailable: true,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ArcGIS sends epoch ms; an ISO string is passed through. */
function epochToIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v).toISOString();
  }
  const s = str(v);
  if (s && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return null;
}

/** Read a layer's own metadata (`?f=json`). Never throws, never guesses. */
export async function fetchZoningLayerMeta(
  layerUrl: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<ZoningLayerMeta> {
  const base = layerUrl.replace(/\/+$/, "");
  try {
    const m = (await fetchJson(`${base}?f=json`)) as {
      name?: unknown;
      maxRecordCount?: unknown;
      spatialReference?: { wkid?: unknown; latestWkid?: unknown } | null;
      editingInfo?: { lastEditDate?: unknown } | null;
    };
    const sr = m.spatialReference ?? null;
    return {
      name: str(m.name),
      sourceWkid: num(sr?.wkid),
      sourceLatestWkid: num(sr?.latestWkid),
      lastEditDate: epochToIso(m.editingInfo?.lastEditDate),
      maxRecordCount: num(m.maxRecordCount),
      unavailable: false,
    };
  } catch {
    // A host that refuses `?f=json` (or an unreachable OCSP endpoint) must not
    // stop the fetch — but the caller is told the metadata is UNAVAILABLE
    // rather than handed an assumed projection or vintage.
    return { ...EMPTY_META };
  }
}

/**
 * Verify that a fetched page really is in WGS84 degrees.
 *
 * `outSR=4326` is REQUESTED on every page, but a host that ignores it returns
 * its own source frame (Austin's is state-plane FEET, x ≈ 3.1e6). PIP would
 * then compare degrees against feet, match nothing, and report a clean 0% —
 * indistinguishable from "the city has no zoning here". A bbox outside the
 * plausible Texas WGS84 envelope (the same `isPlausibleTexasWgs84Bbox` guard
 * the parcel ingest uses, reused rather than re-derived) is proof the request
 * was ignored, so the run fails loudly instead of stamping nothing.
 */
export function assertWgs84Frame(
  features: RawZoningFeature[],
  layerUrl: string,
): void {
  for (const f of features) {
    if (!f.geometry) continue;
    const bbox = bboxOfGeometry(f.geometry);
    if (!bbox || isPlausibleTexasWgs84Bbox(bbox)) continue;
    throw new Error(
      `zoning layer ${layerUrl} returned geometry outside the plausible Texas ` +
        `WGS84 envelope (west=${bbox.westLng}, south=${bbox.southLat}, ` +
        `east=${bbox.eastLng}, north=${bbox.northLat}) — outSR=4326 was ` +
        "ignored, so PIP against WGS84 parcels would silently match nothing; " +
        "refusing to continue",
    );
  }
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
function pageSizeFromMeta(meta: ZoningLayerMeta): number {
  if (meta.maxRecordCount !== null && meta.maxRecordCount > 0) {
    return Math.min(ZONING_PAGE_SIZE, Math.floor(meta.maxRecordCount));
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
  // Read the layer's own metadata FIRST: page size off its published cap,
  // source spatial reference + vintage reported to the caller, and every page
  // verified to really be in the WGS84 frame that was requested.
  const meta = await fetchZoningLayerMeta(base, fetchJson);
  opts.onMeta?.(meta);
  let pageSize = pageSizeFromMeta(meta);

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
    const reduced = feats.map((f) => reduceZoningFeature(f, opts.cfg));
    assertWgs84Frame(reduced, base);
    for (const f of reduced) {
      out.push(f);
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
