/**
 * Cotality map-proxy cache (cc-agent-D).
 *
 * Persistent cache for the cortex-api `/gis-layer` bbox map mesh
 * (`brokerageGisLayers.ts`) so the same parcels and viewports are not
 * re-fetched from Cotality. The engine assemble (pin) path and the brief
 * underwriting path already cache through `adapter_response_cache`; the
 * in-process bbox mesh path does NOT, and is the Cotality quota burn (up
 * to 4 Spatial Tile + 25 geocode + 25 site-location calls per pan,
 * uncached). Three caches back that path:
 *
 *   - spatial-tile mesh, keyed by snapped grid tile  (TTL ~30d)
 *   - property attributes, keyed by (clip, product)  (TTL ~14d)
 *   - geocode (address -> CLIP), keyed by normalized address  (TTL ~90d)
 *
 * Failure isolation (copied from `adapterCache.ts`): no get/put may throw.
 * A DB error logs and degrades to a live fetch (get -> null, put -> no-op),
 * so the cache can never fail a `/gis-layer` request. TTLs are
 * env-overridable; `0` disables a given cache (get always misses, put
 * always no-ops).
 */

import { db } from "@workspace/db";
import {
  cotalitySpatialTileCache,
  cotalityPropertyAttrCache,
  cotalityGeocodeCache,
} from "@workspace/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { logger as defaultLogger } from "./logger";

/** TTL defaults. Parcel geometry is near-static; addresses essentially permanent. */
export const DEFAULT_TILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const DEFAULT_PROPERTY_ATTR_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14d
export const DEFAULT_GEOCODE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d

/** Default tile grid in degrees (~2.2km at the equator). Env-tunable. */
export const DEFAULT_TILE_GRID_DEG = 0.02;

function ttlFromEnv(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function getTileCacheTtlMs(
  envValue: string | undefined = process.env.COTALITY_TILE_CACHE_TTL_MS,
): number {
  return ttlFromEnv(envValue, DEFAULT_TILE_CACHE_TTL_MS);
}

export function getPropertyAttrCacheTtlMs(
  envValue: string | undefined = process.env.COTALITY_PROPERTY_ATTR_CACHE_TTL_MS,
): number {
  return ttlFromEnv(envValue, DEFAULT_PROPERTY_ATTR_CACHE_TTL_MS);
}

export function getGeocodeCacheTtlMs(
  envValue: string | undefined = process.env.COTALITY_GEOCODE_CACHE_TTL_MS,
): number {
  return ttlFromEnv(envValue, DEFAULT_GEOCODE_CACHE_TTL_MS);
}

export function getTileGridDeg(
  envValue: string | undefined = process.env.COTALITY_TILE_GRID_DEG,
): number {
  if (envValue === undefined || envValue === "") return DEFAULT_TILE_GRID_DEG;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TILE_GRID_DEG;
  return parsed;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export interface TileBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

/**
 * Snap a coordinate down to the grid so nearby pans collapse to the same
 * cell boundary. `Math.floor` (not round) so a cell's lower-left corner is
 * stable regardless of where inside the cell the request landed.
 */
function snapDown(value: number, gridDeg: number): number {
  return Math.floor(value / gridDeg) * gridDeg;
}

/**
 * Build the spatial-tile cache key for a request. MVP form: snap the bbox
 * corners to the grid and join with the layer, so any viewport inside the
 * same snapped cell shares a row. Coordinates are fixed to 5 decimals so
 * the key is byte-stable across float drift. Upgrades to true per-cell
 * tiling later without a schema change (the column holds either form).
 */
export function tileKey(
  layer: string,
  bbox: TileBbox,
  gridDeg: number = getTileGridDeg(),
): string {
  const w = snapDown(bbox.westLng, gridDeg).toFixed(5);
  const s = snapDown(bbox.southLat, gridDeg).toFixed(5);
  const e = snapDown(bbox.eastLng, gridDeg).toFixed(5);
  const n = snapDown(bbox.northLat, gridDeg).toFixed(5);
  return `${layer}:g${gridDeg}:${w},${s},${e},${n}`;
}

/** Normalize an address into the geocode-cache key. */
export function normalizeAddrKey(
  streetAddress: string,
  city: string,
  state: string,
): string {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(streetAddress)}|${norm(city)}|${state.trim().toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Spatial-tile cache
// ---------------------------------------------------------------------------

export interface SpatialTileCacheHit {
  payload: unknown;
  featureCount: number;
  cachedAt: Date;
}

export async function getSpatialTile(
  key: string,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<SpatialTileCacheHit | null> {
  const ttlMs = opts?.ttlMs ?? getTileCacheTtlMs();
  if (ttlMs <= 0) return null;
  const log = opts?.log ?? defaultLogger;
  try {
    const rows = await db
      .select({
        payload: cotalitySpatialTileCache.payload,
        featureCount: cotalitySpatialTileCache.featureCount,
        createdAt: cotalitySpatialTileCache.createdAt,
      })
      .from(cotalitySpatialTileCache)
      .where(
        and(
          eq(cotalitySpatialTileCache.tileKey, key),
          gt(cotalitySpatialTileCache.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      payload: row.payload,
      featureCount: row.featureCount,
      cachedAt: row.createdAt,
    };
  } catch (err) {
    log.warn({ err, tileKey: key }, "gisCache: spatial-tile get failed");
    return null;
  }
}

export async function putSpatialTile(
  key: string,
  payload: unknown,
  featureCount: number,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<void> {
  const ttlMs = opts?.ttlMs ?? getTileCacheTtlMs();
  if (ttlMs <= 0) return;
  const log = opts?.log ?? defaultLogger;
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(cotalitySpatialTileCache)
      .values({
        tileKey: key,
        payload: payload as Record<string, unknown>,
        featureCount,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: cotalitySpatialTileCache.tileKey,
        set: {
          payload: payload as Record<string, unknown>,
          featureCount,
          expiresAt,
          createdAt: sql`now()`,
        },
      });
  } catch (err) {
    log.warn({ err, tileKey: key }, "gisCache: spatial-tile put failed");
  }
}

// ---------------------------------------------------------------------------
// Property attribute cache
// ---------------------------------------------------------------------------

export type CotalityAttrProduct =
  | "site-location"
  | "rent-avm"
  | "propensity"
  | "hoa"
  | "ownership"
  | "comparables";

export interface PropertyAttrCacheHit {
  payload: unknown;
  cachedAt: Date;
}

export async function getPropertyAttr(
  clip: string,
  product: CotalityAttrProduct,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<PropertyAttrCacheHit | null> {
  const ttlMs = opts?.ttlMs ?? getPropertyAttrCacheTtlMs();
  if (ttlMs <= 0) return null;
  const log = opts?.log ?? defaultLogger;
  try {
    const rows = await db
      .select({
        payload: cotalityPropertyAttrCache.payload,
        createdAt: cotalityPropertyAttrCache.createdAt,
      })
      .from(cotalityPropertyAttrCache)
      .where(
        and(
          eq(cotalityPropertyAttrCache.clip, clip),
          eq(cotalityPropertyAttrCache.product, product),
          gt(cotalityPropertyAttrCache.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { payload: row.payload, cachedAt: row.createdAt };
  } catch (err) {
    log.warn({ err, clip, product }, "gisCache: property-attr get failed");
    return null;
  }
}

export async function putPropertyAttr(
  clip: string,
  product: CotalityAttrProduct,
  payload: unknown,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<void> {
  const ttlMs = opts?.ttlMs ?? getPropertyAttrCacheTtlMs();
  if (ttlMs <= 0) return;
  const log = opts?.log ?? defaultLogger;
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(cotalityPropertyAttrCache)
      .values({
        clip,
        product,
        payload: payload as Record<string, unknown>,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          cotalityPropertyAttrCache.clip,
          cotalityPropertyAttrCache.product,
        ],
        set: {
          payload: payload as Record<string, unknown>,
          expiresAt,
          createdAt: sql`now()`,
        },
      });
  } catch (err) {
    log.warn({ err, clip, product }, "gisCache: property-attr put failed");
  }
}

// ---------------------------------------------------------------------------
// Geocode (address -> CLIP) cache, with negative caching
// ---------------------------------------------------------------------------

export interface GeocodeCacheHit {
  /** Resolved CLIP, or null for a cached negative (address did not geocode). */
  clip: string | null;
  cachedAt: Date;
}

export async function getGeocodeClip(
  addrNorm: string,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<GeocodeCacheHit | null> {
  const ttlMs = opts?.ttlMs ?? getGeocodeCacheTtlMs();
  if (ttlMs <= 0) return null;
  const log = opts?.log ?? defaultLogger;
  try {
    const rows = await db
      .select({
        clip: cotalityGeocodeCache.clip,
        createdAt: cotalityGeocodeCache.createdAt,
      })
      .from(cotalityGeocodeCache)
      .where(
        and(
          eq(cotalityGeocodeCache.addrNorm, addrNorm),
          gt(cotalityGeocodeCache.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { clip: row.clip ?? null, cachedAt: row.createdAt };
  } catch (err) {
    log.warn({ err, addrNorm }, "gisCache: geocode get failed");
    return null;
  }
}

/** Cache a geocode result. `clip = null` caches a negative (no match). */
export async function putGeocodeClip(
  addrNorm: string,
  clip: string | null,
  opts?: { log?: Logger; ttlMs?: number },
): Promise<void> {
  const ttlMs = opts?.ttlMs ?? getGeocodeCacheTtlMs();
  if (ttlMs <= 0) return;
  const log = opts?.log ?? defaultLogger;
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    await db
      .insert(cotalityGeocodeCache)
      .values({ addrNorm, clip, resolved: true, expiresAt })
      .onConflictDoUpdate({
        target: cotalityGeocodeCache.addrNorm,
        set: { clip, resolved: true, expiresAt, createdAt: sql`now()` },
      });
  } catch (err) {
    log.warn({ err, addrNorm }, "gisCache: geocode put failed");
  }
}
