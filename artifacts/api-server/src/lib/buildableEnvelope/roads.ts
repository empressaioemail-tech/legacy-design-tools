/**
 * Nearest-road fetch for edge labeling (the HIGH-confidence front-edge signal).
 *
 * Self-contained OSM Overpass query for road centerlines near a lat/lng. The
 * repo already proves this query shape in the Grand County / Lemhi adapters
 * (`way(around:R,lat,lng)[highway];out body geom`), but those adapters are
 * jurisdiction-gated to UT/ID. This is a small, ungated, best-effort helper so
 * the buildable-envelope derivation can use the same signal for ANY parcel
 * (Central-TX pilot included) — it is a direct upstream fetch, not the map
 * proxy, so it needs no allowlist entry.
 *
 * === Why this file was hardened (F10) ===
 * The shared public Overpass instance (`overpass-api.de`) is the ONLY road
 * source in-tree (no store/adapter carries road centerlines), and it is
 * fragile: it runs 2 concurrent slots, and under load returns HTTP 504 with a
 * "server is probably too busy" HTML body — swallowed by the old `!res.ok`
 * guard — or straggles past a tight abort cap. Live sampling of the exact
 * `way(around:90,…)[highway]` query from a Cloud-Run-like egress showed ~50% of
 * requests 504-ing at 6–7.6 s. With the old 6 s cap + no retry + no cache, the
 * road tier was DARK in prod: every parcel fell through to the rotation-prone
 * `point` tier. The fix here is three-fold:
 *   1) CACHE by rounded-coordinate tile key (roads change slowly; a long TTL is
 *      fine) so most requests hit warm and never touch Overpass at all — the
 *      highest-leverage, lowest-infra change.
 *   2) HARDEN the fetch: a higher default cap, a single retry on 504/timeout/
 *      429 with light backoff, and a urlencoded `data=` body (well-formed POST,
 *      the shape the public instance documents) instead of raw text/plain.
 *   3) surface each way's `name` tag so the caller can prefer the SITUS-named
 *      street (cul-de-sac defense) over merely the nearest/longest way.
 *
 * Still best-effort by design: any genuine failure (both attempts time out,
 * 5xx, non-JSON) resolves to [] so edge labeling degrades to the geocoded-point
 * signal rather than throwing. Correctness of the ENVELOPE never depends on this
 * call succeeding; only its confidence does. The fix makes the road tier fire
 * MORE, it does not remove the point/shape fallback (honest degradation).
 */

import type { RoadPolyline } from "./edgeLabeling";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT =
  "hauska-buildable-envelope/1.0 (+https://hauska.dev; roads via OSM Overpass)";
const DEFAULT_RADIUS_M = 90;
/**
 * Raised from 6_000. Live sampling showed the shared instance often answers a
 * `around:90` query at 6–8 s under load; a 6 s cap aborted those (which then
 * looked like an outage). 12 s clears the observed p~90 while still bounding the
 * request so the envelope route never hangs. A single retry (below) covers the
 * remaining 504/timeout tail without a runaway wait.
 */
const DEFAULT_TIMEOUT_MS = 12_000;
/** Backoff before the one retry, on 504/429/timeout. */
const RETRY_BACKOFF_MS = 600;

/**
 * Tile size for the road cache key, in degrees (~0.001 deg lat ≈ 111 m). Roads
 * are stable at this granularity and two nearby parcels share a tile, so the
 * fetch amortizes. Rounding both lat and lng to this grid is the cache key.
 */
const CACHE_TILE_DEG = 0.001;
/** Roads change slowly; a long TTL is fine. 24 h. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded LRU size cap (entries). Keeps memory flat on a long-lived process. */
const CACHE_MAX_ENTRIES = 500;

/**
 * A road centerline enriched with its OSM `name` (when tagged), so the caller
 * can prefer the situs-named street. `polyline` is the lng/lat geometry.
 */
export interface NamedRoad {
  /** OSM `name` tag, normalized-comparable by the caller. Null when untagged. */
  name: string | null;
  polyline: RoadPolyline;
  /** OSM `highway` class (residential, tertiary, service, …), for debugging. */
  highway: string | null;
}

/** Injected fetch (tests); defaults to global fetch. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface NearestRoadInput {
  lat: number;
  lng: number;
  radiusMeters?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Bypass + skip the module cache (tests). */
  noCache?: boolean;
}

interface OverpassWay {
  type?: string;
  tags?: { name?: unknown; highway?: unknown };
  geometry?: { lat: number; lon: number }[];
}

/**
 * Parse Overpass `elements` into named road centerlines, sorted by descending
 * length so the caller can prefer the most substantial nearby street.
 */
export function namedRoadsFromOverpass(elements: unknown): NamedRoad[] {
  if (!Array.isArray(elements)) return [];
  const roads: NamedRoad[] = [];
  for (const el of elements as OverpassWay[]) {
    if (!el || el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const pts: [number, number][] = [];
    for (const g of el.geometry) {
      if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
        pts.push([g.lon, g.lat]);
      }
    }
    if (pts.length < 2) continue;
    const name =
      typeof el.tags?.name === "string" && el.tags.name.trim()
        ? el.tags.name.trim()
        : null;
    const highway =
      typeof el.tags?.highway === "string" ? el.tags.highway : null;
    roads.push({ name, polyline: pts, highway });
  }
  // Longest first (a substantial street beats a driveway stub).
  roads.sort(
    (a, b) => polylineLengthDeg(b.polyline) - polylineLengthDeg(a.polyline),
  );
  return roads;
}

/**
 * Back-compat: bare polylines (longest first). Retained so any existing caller
 * that only wants geometry keeps working; the enriched `namedRoadsFromOverpass`
 * is preferred for the situs-name match.
 */
export function roadPolylinesFromOverpass(elements: unknown): RoadPolyline[] {
  return namedRoadsFromOverpass(elements).map((r) => r.polyline);
}

function polylineLengthDeg(line: RoadPolyline): number {
  let len = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    len += Math.hypot(
      line[i + 1]![0] - line[i]![0],
      line[i + 1]![1] - line[i]![1],
    );
  }
  return len;
}

// === Bounded LRU cache, keyed by rounded-coordinate tile + radius ===

interface CacheEntry {
  roads: NamedRoad[];
  expiresAt: number;
}

/** Insertion-order Map doubles as an LRU: delete+set on hit moves to newest. */
const roadCache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lng: number, radius: number): string {
  const qLat = Math.round(lat / CACHE_TILE_DEG) * CACHE_TILE_DEG;
  const qLng = Math.round(lng / CACHE_TILE_DEG) * CACHE_TILE_DEG;
  return `${qLat.toFixed(4)},${qLng.toFixed(4)}@${radius}`;
}

function cacheGet(key: string): NamedRoad[] | null {
  const hit = roadCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    roadCache.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to the newest position.
  roadCache.delete(key);
  roadCache.set(key, hit);
  return hit.roads;
}

function cacheSet(key: string, roads: NamedRoad[]): void {
  if (roadCache.has(key)) roadCache.delete(key);
  roadCache.set(key, { roads, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict oldest until under the cap.
  while (roadCache.size > CACHE_MAX_ENTRIES) {
    const oldest = roadCache.keys().next().value;
    if (oldest === undefined) break;
    roadCache.delete(oldest);
  }
}

/** Test/ops hook: clear the module road cache. */
export function _clearRoadCache(): void {
  roadCache.clear();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One Overpass attempt. Returns parsed roads on a clean 200+JSON, or a typed
 * failure so the caller can decide whether to retry (504/429/timeout are
 * retryable; a clean empty 200 is not a failure).
 */
async function overpassAttempt(
  doFetch: FetchLike,
  query: string,
  timeoutMs: number,
): Promise<
  | { ok: true; roads: NamedRoad[] }
  | { ok: false; retryable: boolean; status: number }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(OVERPASS_URL, {
      method: "POST",
      // urlencoded `data=` — the well-formed POST the public instance
      // documents, rather than a raw text/plain body.
      body: new URLSearchParams({ data: query }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 504 (busy dispatcher) and 429 (rate limit) are the observed transient
      // failures worth one retry; other non-2xx are treated as terminal.
      const retryable = res.status === 504 || res.status === 429;
      return { ok: false, retryable, status: res.status };
    }
    const json: unknown = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      // A 200 with a non-JSON body (Overpass sometimes returns an HTML busy
      // error with a 200) — retry once.
      return { ok: false, retryable: true, status: 200 };
    }
    return {
      ok: true,
      roads: namedRoadsFromOverpass((json as { elements?: unknown }).elements),
    };
  } catch {
    // Abort (timeout) or network error — retryable.
    return { ok: false, retryable: true, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch nearby named road centerlines around a point, cached by tile and
 * hardened with one retry. Returns [] on genuine failure (never throws) so
 * labeling degrades gracefully.
 */
export async function fetchNearbyRoads(
  input: NearestRoadInput,
): Promise<NamedRoad[]> {
  const radius = input.radiusMeters ?? DEFAULT_RADIUS_M;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));

  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) return [];

  const key = cacheKey(input.lat, input.lng, radius);
  if (!input.noCache) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  const query =
    `[out:json][timeout:20];` +
    `way(around:${radius},${input.lat},${input.lng})[highway];` +
    `out body geom 60;`;

  // Attempt, then one retry on a retryable failure.
  let result = await overpassAttempt(doFetch, query, timeoutMs);
  if (!result.ok && result.retryable) {
    await sleep(RETRY_BACKOFF_MS);
    result = await overpassAttempt(doFetch, query, timeoutMs);
  }

  if (!result.ok) return [];

  // Cache successful fetches — including a legitimately empty result (no roads
  // near a rural parcel), so we don't re-hammer Overpass for the same tile.
  if (!input.noCache) cacheSet(key, result.roads);
  return result.roads;
}

/**
 * Back-compat wrapper: bare polylines (longest first). Preserves the prior
 * `fetchNearestRoads` shape/name for any existing caller.
 */
export async function fetchNearestRoads(
  input: NearestRoadInput,
): Promise<RoadPolyline[]> {
  return (await fetchNearbyRoads(input)).map((r) => r.polyline);
}
