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
 * Best-effort by design: any failure (timeout, 406/5xx, non-JSON) resolves to
 * null so edge labeling degrades to the geocoded-point signal rather than
 * throwing. Correctness of the ENVELOPE never depends on this call succeeding;
 * only its confidence does.
 */

import type { RoadPolyline } from "./edgeLabeling";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT =
  "hauska-buildable-envelope/1.0 (+https://hauska.dev; roads via OSM Overpass)";
const DEFAULT_RADIUS_M = 90;
const DEFAULT_TIMEOUT_MS = 6_000;

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
}

interface OverpassWay {
  type?: string;
  geometry?: { lat: number; lon: number }[];
}

/**
 * Parse Overpass `elements` into road polylines (lng/lat), sorted by descending
 * length so the caller can prefer the most substantial nearby street.
 */
export function roadPolylinesFromOverpass(elements: unknown): RoadPolyline[] {
  if (!Array.isArray(elements)) return [];
  const lines: RoadPolyline[] = [];
  for (const el of elements as OverpassWay[]) {
    if (!el || el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const pts: [number, number][] = [];
    for (const g of el.geometry) {
      if (
        g &&
        Number.isFinite(g.lat) &&
        Number.isFinite(g.lon)
      ) {
        pts.push([g.lon, g.lat]);
      }
    }
    if (pts.length >= 2) lines.push(pts);
  }
  // Longest first (a substantial street beats a driveway stub).
  lines.sort((a, b) => polylineLengthDeg(b) - polylineLengthDeg(a));
  return lines;
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

/**
 * Fetch the nearest road centerline(s) around a point. Returns [] on any
 * failure (never throws) so labeling degrades gracefully.
 */
export async function fetchNearestRoads(
  input: NearestRoadInput,
): Promise<RoadPolyline[]> {
  const radius = input.radiusMeters ?? DEFAULT_RADIUS_M;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));

  const query =
    `[out:json][timeout:20];` +
    `way(around:${radius},${input.lat},${input.lng})[highway];` +
    `out body geom 40;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(OVERPASS_URL, {
      method: "POST",
      body: query,
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": USER_AGENT,
        Accept: "application/json, */*;q=0.1",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json: unknown = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return [];
    return roadPolylinesFromOverpass((json as { elements?: unknown }).elements);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
