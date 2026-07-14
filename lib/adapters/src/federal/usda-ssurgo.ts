/**
 * USDA NRCS SSURGO soils — federal subsurface adapter.
 *
 * Source of truth is USDA Soil Data Access (SDA) on
 * `sdmdataaccess.sc.egov.usda.gov`: the tabular POST endpoint resolves the
 * map unit at a point (`SDA_Get_Mukey_from_intersection_with_WktWgs84`)
 * plus dominant-component and muaggatt attributes in one query, and the
 * SDA WFS endpoint serves map-unit polygons for bbox/map use.
 *
 * The gSSURGO ArcGIS host (`nrcsgeoservices.sc.egov.usda.gov`) resets TLS
 * handshakes from Cloud Run (and most non-browser clients) — the long-lived
 * "SSURGO ECONNRESET" degradation. It is therefore only queried as
 * best-effort enrichment; its failure never fails the adapter when SDA
 * answers. (Verified live 2026-07-14: both USDA ArcGIS hosts reset TLS
 * pre-handshake while every SDA endpoint on sdmdataaccess responded
 * in <1s.)
 *
 * Off-US or unmapped parcels emit a deterministic `no-coverage` verdict
 * (neutral pill) rather than a red failure.
 */

import { arcgisPointQuery } from "../arcgis";
import { fetchWithRetry } from "../retry";
import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
} from "../types";
import { federalGeocodeApplies, isUsLatLng } from "./_federalGeocodeGate";

/** gSSURGO map-unit polygon layer (national). Enrichment-only; see header. */
export const USDA_SSURGO_MAPUNIT_LAYER =
  "https://nrcsgeoservices.sc.egov.usda.gov/arcgis/rest/services/soils/gssurgo/MapServer/0";

export const USDA_SSURGO_SDA_ENDPOINT =
  "https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest";

/** Fallback SDA endpoint (newer Tabular service path). */
export const USDA_SSURGO_SDA_ENDPOINT_FALLBACK =
  "https://sdmdataaccess.sc.egov.usda.gov/Tabular/SDMTabularService/post.rest";

/**
 * SDA WFS — serves SSURGO map-unit polygons by bbox on the same healthy
 * host as the tabular endpoint. Axis order note: this MapServer emits
 * GML2 `<gml:coordinates>` pairs as `lat,lng` and expects the request
 * BBOX as `minLng,minLat,maxLng,maxLat`.
 */
export const USDA_SSURGO_WFS_ENDPOINT =
  "https://sdmdataaccess.sc.egov.usda.gov/Spatial/SDMWGS84Geographic.wfs";

/**
 * Browser-ish UA for USDA hosts. Several USDA front doors 406/reset
 * requests without a recognizable User-Agent.
 */
export const USDA_HTTP_USER_AGENT =
  "Mozilla/5.0 (compatible; HauskaCortex/1.0; +https://cortex.empressa.io)";

export const USDA_SSURGO_PROVIDER_LABEL =
  "USDA NRCS Soil Survey Geographic Database (SSURGO)";

/**
 * SSURGO county-level updates roll out continuously; 24 months matches
 * other federal subsurface snapshots and flags engagements opened years
 * apart without firing stale on every annual county refresh.
 */
export const USDA_SSURGO_FRESHNESS_THRESHOLD_MONTHS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function wktPoint(longitude: number, latitude: number): string {
  return `POINT(${longitude} ${latitude})`;
}

/**
 * Point query against SDA. Column set verified against the live schema
 * (2026-07-14): muaggatt has `brockdepmin` / `wtdepannmin` but no
 * `brockdepmax` / `wtdepannmax` — the previous query named those and SDA
 * rejected it with HTTP 400 "Invalid column name" on every call.
 * `areasymbol` comes from the legend join; `drclassdcd` / `hydgrpdcd`
 * are map-unit-level fallbacks for the component readings.
 */
function buildSdaSoilQuery(longitude: number, latitude: number): string {
  const wkt = wktPoint(longitude, latitude);
  return `
SELECT TOP 1
  mu.mukey,
  mu.musym,
  mu.muname,
  l.areasymbol,
  ma.brockdepmin,
  ma.wtdepannmin,
  ma.drclassdcd,
  ma.hydgrpdcd,
  c.compname,
  c.drainagecl,
  c.hydgrp,
  c.slope_r,
  (SELECT TOP 1 ci.interplr
     FROM cointerp ci
    WHERE ci.cokey = c.cokey
      AND ci.mrulename = 'ENG - Shrink-Swell Potential'
      AND ci.ruledepth = 0) AS shrinkswell
FROM mapunit mu
INNER JOIN legend l ON l.lkey = mu.lkey
INNER JOIN component c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes'
LEFT JOIN muaggatt ma ON ma.mukey = mu.mukey
WHERE mu.mukey IN (
  SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')
)
ORDER BY c.comppct_r DESC
`.trim();
}

/** Foundation-risk choropleth score 1 (low) .. 5 (high) from shrink-swell interp. */
export function foundationRiskScoreFromShrinkSwell(
  shrinkSwell: string | null | undefined,
): number {
  if (!shrinkSwell) return 3;
  const v = shrinkSwell.trim().toLowerCase();
  if (v.includes("very high") || v.includes("severe")) return 5;
  if (v.includes("high")) return 4;
  if (v.includes("moderate")) return 3;
  if (v.includes("low")) return 2;
  if (v.includes("none") || v.includes("very low") || v.includes("negligible")) {
    return 1;
  }
  return 3;
}

export async function querySdaShrinkSwell(
  ctx: Pick<AdapterContext, "fetchImpl" | "signal">,
  longitude: number,
  latitude: number,
): Promise<string | null> {
  const row = await querySdaSoils(
    ctx as AdapterContext,
    longitude,
    latitude,
  ).catch(() => null);
  if (!row) return null;
  return (
    pickString(row.shrinkswell) ??
    pickString(row.SHRINKSWELL) ??
    null
  );
}

interface SdaTableRow {
  [key: string]: unknown;
}

/**
 * Parse an SDA `format=JSON+COLUMNNAME` response body into keyed rows.
 *
 * The real wire shape is `{ "Table": [[col, col, …], [val, val, …], …] }`
 * — the FIRST row is column names and every subsequent row is a value
 * array. The previous implementation indexed `Table[0]` and read named
 * properties off it, i.e. it always consumed the header row and every
 * attribute came back `undefined` even on a successful call. Object rows
 * are still tolerated in case a proxy or fixture provides them.
 */
export function parseSdaTableRows(json: unknown): SdaTableRow[] {
  if (!json || typeof json !== "object") return [];
  const table = (json as { Table?: unknown }).Table;
  if (!Array.isArray(table) || table.length === 0) return [];

  const first = table[0];
  if (Array.isArray(first)) {
    const columns = first.map((c) => String(c));
    const rows: SdaTableRow[] = [];
    for (let i = 1; i < table.length; i++) {
      const values = table[i];
      if (!Array.isArray(values)) continue;
      const row: SdaTableRow = {};
      for (let c = 0; c < columns.length; c++) {
        row[columns[c]] = values[c] ?? null;
      }
      rows.push(row);
    }
    return rows;
  }

  return table.filter(
    (row): row is SdaTableRow =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

async function postSdaQuery(
  ctx: Pick<AdapterContext, "fetchImpl" | "signal">,
  endpoint: string,
  query: string,
): Promise<SdaTableRow[]> {
  const body = new URLSearchParams({
    query,
    format: "JSON+COLUMNNAME",
  });
  const { response: res, attempts } = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, */*;q=0.1",
        "User-Agent": USDA_HTTP_USER_AGENT,
      },
      body: body.toString(),
      signal: ctx.signal,
    },
    {
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      upstreamLabel: "USDA Soil Data Access",
      maxAttempts: 3,
      baseDelayMs: 1_000,
      captureThrowsAsResult: true,
    },
  );
  if (!res.ok) {
    if (res.status === 599 && attempts >= 3) {
      throw new AdapterRunError(
        "network-error",
        `USDA Soil Data Access unreachable after ${attempts} attempts.`,
      );
    }
    throw new AdapterRunError(
      "upstream-error",
      `USDA Soil Data Access responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}. Use Force refresh to retry.`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `USDA Soil Data Access response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json || typeof json !== "object") {
    throw new AdapterRunError(
      "parse-error",
      "USDA Soil Data Access response was not a JSON object",
    );
  }
  return parseSdaTableRows(json);
}

async function querySdaSoilsAtEndpoint(
  ctx: AdapterContext,
  longitude: number,
  latitude: number,
  endpoint: string,
): Promise<SdaTableRow | null> {
  const rows = await postSdaQuery(
    ctx,
    endpoint,
    buildSdaSoilQuery(longitude, latitude),
  );
  return rows[0] ?? null;
}

async function querySdaSoils(
  ctx: AdapterContext,
  longitude: number,
  latitude: number,
): Promise<SdaTableRow | null> {
  try {
    const primary = await querySdaSoilsAtEndpoint(
      ctx,
      longitude,
      latitude,
      USDA_SSURGO_SDA_ENDPOINT,
    );
    if (primary) return primary;
  } catch (err) {
    if (
      err instanceof AdapterRunError &&
      (err.code === "network-error" || err.code === "upstream-error")
    ) {
      // fall through to alternate endpoint
    } else {
      throw err;
    }
  }
  try {
    return await querySdaSoilsAtEndpoint(
      ctx,
      longitude,
      latitude,
      USDA_SSURGO_SDA_ENDPOINT_FALLBACK,
    );
  } catch (err) {
    if (err instanceof AdapterRunError) {
      throw new AdapterRunError(
        "network-error",
        "USDA Soil Data Access unreachable after 3 attempts on primary and fallback SDA hosts.",
      );
    }
    throw err;
  }
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** muaggatt depth attributes are centimeters; payload fields are feet. */
function cmToFeet(value: number | null): number | null {
  if (value === null) return null;
  return Math.round((value / 30.48) * 10) / 10;
}

// ─── SSURGO map-unit polygons via SDA WFS (bbox / map path) ─────────

export interface SsurgoWfsBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface SsurgoWfsPolygonFeature {
  type: "Feature";
  geometry: {
    type: "MultiPolygon";
    coordinates: number[][][][];
  };
  properties: Record<string, unknown>;
}

const WFS_MAX_FEATURES_DEFAULT = 200;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textOf(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<ms:${tag}>([^<]*)</ms:${tag}>`));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

/**
 * Parse one `<gml:coordinates>` block into a GeoJSON ring.
 *
 * The server emits pairs as `lat,lng` (verified live), but rather than
 * hard-coding that, orientation is resolved against the request bbox:
 * whichever interpretation lands inside (or nearer) the query window
 * wins. This keeps the parser correct if the host ever flips to x,y.
 */
function parseCoordinateRing(
  text: string,
  bbox: SsurgoWfsBbox,
): number[][] {
  const pairs = text
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n)));
  if (pairs.length === 0) return [];

  const [a, b] = pairs[0];
  const centerLng = (bbox.westLng + bbox.eastLng) / 2;
  const centerLat = (bbox.southLat + bbox.northLat) / 2;
  // Interpretation 1: pair = lat,lng → lng = b. Interpretation 2: pair = lng,lat.
  const dist1 = Math.abs(b - centerLng) + Math.abs(a - centerLat);
  const dist2 = Math.abs(a - centerLng) + Math.abs(b - centerLat);
  const latFirst = dist1 <= dist2;

  return pairs.map(([x, y]) => (latFirst ? [y, x] : [x, y]));
}

function parsePolygonBlock(block: string, bbox: SsurgoWfsBbox): number[][][] {
  const rings: number[][][] = [];
  const outer = block.match(
    /<gml:outerBoundaryIs>[\s\S]*?<gml:coordinates>([\s\S]*?)<\/gml:coordinates>[\s\S]*?<\/gml:outerBoundaryIs>/,
  );
  if (outer) {
    const ring = parseCoordinateRing(outer[1], bbox);
    if (ring.length >= 4) rings.push(ring);
  }
  const innerRe =
    /<gml:innerBoundaryIs>[\s\S]*?<gml:coordinates>([\s\S]*?)<\/gml:coordinates>[\s\S]*?<\/gml:innerBoundaryIs>/g;
  let m: RegExpExecArray | null;
  while ((m = innerRe.exec(block)) !== null) {
    const ring = parseCoordinateRing(m[1], bbox);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Parse an SDA WFS GetFeature (GML2) response into GeoJSON features. */
export function parseSsurgoWfsGml(
  xml: string,
  bbox: SsurgoWfsBbox,
): SsurgoWfsPolygonFeature[] {
  const features: SsurgoWfsPolygonFeature[] = [];
  const memberRe = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
  let member: RegExpExecArray | null;
  while ((member = memberRe.exec(xml)) !== null) {
    const block = member[1];
    const polys: number[][][][] = [];
    const polyRe = /<gml:Polygon>([\s\S]*?)<\/gml:Polygon>/g;
    let poly: RegExpExecArray | null;
    while ((poly = polyRe.exec(block)) !== null) {
      const rings = parsePolygonBlock(poly[1], bbox);
      if (rings.length > 0) polys.push(rings);
    }
    if (polys.length === 0) continue;
    features.push({
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: polys },
      properties: {
        mupolygonkey: textOf(block, "mupolygonkey"),
        mukey: textOf(block, "mukey"),
        MUKEY: textOf(block, "mukey"),
        musym: textOf(block, "musym"),
        MUSYM: textOf(block, "musym"),
        nationalmusym: textOf(block, "nationalmusym"),
        areaSymbol: textOf(block, "areasymbol"),
        muareaacres: pickNumber(textOf(block, "muareaacres")),
      },
    });
  }
  return features;
}

/**
 * Fetch SSURGO map-unit polygons for a bbox from the SDA WFS.
 * Throws {@link AdapterRunError} (`network-error` / `upstream-error`) so
 * callers keep the honest degraded envelope when USDA is unreachable.
 */
export async function fetchSsurgoWfsPolygons(args: {
  bbox: SsurgoWfsBbox;
  maxFeatures?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ features: SsurgoWfsPolygonFeature[]; truncated: boolean }> {
  const maxFeatures = args.maxFeatures ?? WFS_MAX_FEATURES_DEFAULT;
  const { bbox } = args;
  const url =
    `${USDA_SSURGO_WFS_ENDPOINT}?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature` +
    `&TYPENAME=MapunitPoly&SRSNAME=EPSG:4326&MAXFEATURES=${maxFeatures}` +
    `&BBOX=${bbox.westLng},${bbox.southLat},${bbox.eastLng},${bbox.northLat}`;

  const { response: res, attempts, throwExcerpt } = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "text/xml, application/xml",
        "User-Agent": USDA_HTTP_USER_AGENT,
      },
      signal: args.signal,
    },
    {
      fetchImpl: args.fetchImpl,
      signal: args.signal,
      upstreamLabel: "USDA SDA WFS (SSURGO polygons)",
      maxAttempts: 3,
      baseDelayMs: 1_000,
      captureThrowsAsResult: true,
    },
  );
  if (!res.ok) {
    if (res.status === 599) {
      throw new AdapterRunError(
        "network-error",
        `USDA SDA WFS unreachable after ${attempts} attempts${throwExcerpt ? ` (${throwExcerpt})` : ""}.`,
      );
    }
    throw new AdapterRunError(
      "upstream-error",
      `USDA SDA WFS responded with HTTP ${res.status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
    );
  }
  const xml = await res.text();
  if (xml.includes("<ServiceExceptionReport")) {
    const msg = xml.match(/<ServiceException>([\s\S]*?)<\/ServiceException>/);
    throw new AdapterRunError(
      "upstream-error",
      `USDA SDA WFS service exception: ${msg ? msg[1].trim().slice(0, 200) : "unknown"}`,
    );
  }
  const features = parseSsurgoWfsGml(xml, bbox);
  return { features, truncated: features.length >= maxFeatures };
}

export interface SsurgoMapunitAttributes {
  mukey: string;
  muname: string | null;
  compname: string | null;
  drainagecl: string | null;
  hydgrp: string | null;
  shrinkswell: string | null;
}

/**
 * Batch-resolve map-unit names + dominant-component attributes for a set
 * of mukeys via SDA tabular (one round trip). Used to enrich WFS polygon
 * features (the WFS carries mukey/musym but no muname or interp columns).
 */
export async function querySdaMapunitAttributesByMukeys(
  ctx: Pick<AdapterContext, "fetchImpl" | "signal">,
  mukeys: string[],
): Promise<Map<string, SsurgoMapunitAttributes>> {
  const result = new Map<string, SsurgoMapunitAttributes>();
  const unique = [...new Set(mukeys.filter((k) => /^\d+$/.test(k)))];
  if (unique.length === 0) return result;

  const inList = unique.map((k) => `'${k}'`).join(",");
  const query = `
SELECT
  mu.mukey,
  mu.muname,
  c.compname,
  c.drainagecl,
  c.hydgrp,
  c.comppct_r,
  (SELECT TOP 1 ci.interplr
     FROM cointerp ci
    WHERE ci.cokey = c.cokey
      AND ci.mrulename = 'ENG - Shrink-Swell Potential'
      AND ci.ruledepth = 0) AS shrinkswell
FROM mapunit mu
INNER JOIN component c ON c.mukey = mu.mukey AND c.majcompflag = 'Yes'
WHERE mu.mukey IN (${inList})
ORDER BY mu.mukey, c.comppct_r DESC
`.trim();

  const rows = await postSdaQuery(ctx, USDA_SSURGO_SDA_ENDPOINT, query);
  for (const row of rows) {
    const mukey = pickString(row.mukey);
    if (!mukey || result.has(mukey)) continue; // first row per mukey = dominant component
    result.set(mukey, {
      mukey,
      muname: pickString(row.muname),
      compname: pickString(row.compname),
      drainagecl: pickString(row.drainagecl),
      hydgrp: pickString(row.hydgrp),
      shrinkswell: pickString(row.shrinkswell),
    });
  }
  return result;
}

// ─── Point adapter ──────────────────────────────────────────────────

export const usdaSsurgoSoilsAdapter: Adapter = {
  adapterKey: "usda:ssurgo-soils",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "usda-ssurgo-soils",
  provider: USDA_SSURGO_PROVIDER_LABEL,
  jurisdictionGate: {},
  appliesTo(ctx) {
    return (
      federalGeocodeApplies(ctx) &&
      isUsLatLng(ctx.parcel.latitude, ctx.parcel.longitude)
    );
  },
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude } = ctx.parcel;

    // SDA is the source of truth; the gSSURGO ArcGIS point intersect is
    // best-effort enrichment only (its host TLS-resets from Cloud Run).
    // Promise.allSettled keeps a dead ArcGIS host from failing the whole
    // adapter when SDA answered — the previous Promise.all did exactly
    // that, surfacing as "SSURGO ECONNRESET" on every run.
    const [mapUnitSettled, sdaSettled] = await Promise.allSettled([
      arcgisPointQuery({
        serviceUrl: USDA_SSURGO_MAPUNIT_LAYER,
        latitude,
        longitude,
        outFields: "MUKEY,MUSYM,MUNAME,AREASYMBOL",
        returnGeometry: false,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        upstreamLabel: "USDA gSSURGO",
      }),
      querySdaSoils(ctx, longitude, latitude),
    ]);

    const sdaRow = sdaSettled.status === "fulfilled" ? sdaSettled.value : null;
    const feature =
      mapUnitSettled.status === "fulfilled"
        ? mapUnitSettled.value.features[0]
        : undefined;

    if (!feature && !sdaRow) {
      // Both legs empty or failed. Distinguish honest no-coverage (both
      // answered, nothing mapped) from connectivity failure.
      if (
        sdaSettled.status === "rejected" &&
        mapUnitSettled.status === "rejected"
      ) {
        const sdaErr = sdaSettled.reason;
        const arcErr = mapUnitSettled.reason;
        const detail = [
          sdaErr instanceof Error ? `SDA: ${sdaErr.message}` : null,
          arcErr instanceof Error ? `gSSURGO: ${arcErr.message}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
        throw new AdapterRunError(
          "network-error",
          `USDA endpoints unreachable. ${detail}`.trim(),
        );
      }
      if (sdaSettled.status === "rejected" && !feature) {
        const sdaErr = sdaSettled.reason;
        throw sdaErr instanceof AdapterRunError
          ? sdaErr
          : new AdapterRunError(
              "network-error",
              sdaErr instanceof Error ? sdaErr.message : String(sdaErr),
            );
      }
      throw new AdapterRunError(
        "no-coverage",
        "No SSURGO soil map unit is mapped at this location.",
      );
    }

    const attrs = feature?.attributes ?? {};
    const mukey =
      pickString(sdaRow?.mukey) ??
      pickString(sdaRow?.MUKEY) ??
      pickString(attrs.MUKEY);
    const musym =
      pickString(sdaRow?.musym) ??
      pickString(sdaRow?.MUSYM) ??
      pickString(attrs.MUSYM);
    const muname =
      pickString(sdaRow?.muname) ??
      pickString(sdaRow?.MUNAME) ??
      pickString(attrs.MUNAME);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: nowIso(),
      payload: {
        kind: "ssurgo-soils",
        mukey,
        musym,
        muname,
        areaSymbol:
          pickString(sdaRow?.areasymbol) ??
          pickString(sdaRow?.AREASYMBOL) ??
          pickString(attrs.AREASYMBOL),
        drainageClass:
          pickString(sdaRow?.drainagecl) ??
          pickString(sdaRow?.DRAINAGECL) ??
          pickString(sdaRow?.drclassdcd),
        foundationRiskScore: foundationRiskScoreFromShrinkSwell(
          pickString(sdaRow?.shrinkswell) ?? pickString(sdaRow?.SHRINKSWELL),
        ),
        hydrologicSoilGroup:
          pickString(sdaRow?.hydgrp) ??
          pickString(sdaRow?.HYDGRP) ??
          pickString(sdaRow?.hydgrpdcd),
        dominantComponent:
          pickString(sdaRow?.compname) ?? pickString(sdaRow?.COMPNAME),
        slopePercentRounded:
          pickNumber(sdaRow?.slope_r) ?? pickNumber(sdaRow?.SLOPE_R),
        // muaggatt reports cm; converted so the field names stay honest.
        // The *Max* columns do not exist in muaggatt (SDA 400s on them),
        // so max depths are null pending a corestrictions-based source.
        depthToBedrockMinFeet: cmToFeet(
          pickNumber(sdaRow?.brockdepmin) ?? pickNumber(sdaRow?.BROCKDEPMIN),
        ),
        depthToBedrockMaxFeet: null,
        waterTableDepthMinFeet: cmToFeet(
          pickNumber(sdaRow?.wtdepannmin) ?? pickNumber(sdaRow?.WTDEPANNMIN),
        ),
        waterTableDepthMaxFeet: null,
        shrinkSwellPotential:
          pickString(sdaRow?.shrinkswell) ?? pickString(sdaRow?.SHRINKSWELL),
        rawMapUnitAttributes: attrs,
        rawSdaRow: sdaRow ?? null,
        gssurgoEnrichmentAvailable: mapUnitSettled.status === "fulfilled",
      },
    };
  },
};
