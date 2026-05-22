import type { Geocode } from "../types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  "Hauska-LegacyDesignTools/0.1 (https://hauska.io; contact@hauska.io)";
const MIN_INTERVAL_MS = 1100; // Nominatim TOS: ≤ 1 req/sec; pad to be safe

// Promise-chain queue: every call waits for the previous to fully complete
// AND for at least MIN_INTERVAL_MS since the last network request started.
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Prevent the queue from rejecting and blocking subsequent calls
  queue = job.catch(() => undefined);
  return job;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  county?: string;
  state?: string;
  country_code?: string;
  postcode?: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: NominatimAddress;
}

export interface GeocodeOptions {
  signal?: AbortSignal;
}

/**
 * Collapse all internal whitespace (newlines, tabs, runs of spaces) to a
 * single space. Engagement addresses arrive multi-line — e.g.
 * "1144 NORTH KAYENTA DR\nMoab UT 84532" — and an embedded newline reaches
 * Nominatim percent-encoded as `%0A`, degrading the free-text match.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Build the broaden-on-miss query ladder for a US address.
 *
 * Nominatim free-text search with `limit=1` misses many rural street
 * addresses that simply are not in OSM at house-number granularity — that
 * is the verified P0-2 failure mode (the Musgrave engagement's
 * "1144 NORTH KAYENTA DR, Moab UT 84532" returned no hit, so the engagement
 * was left with no coordinates and the whole site-context loop dead-ended).
 *
 * Falling back to a city- or ZIP-level query still yields a usable
 * engagement-level geocode: the map centres on the right town and the
 * jurisdiction-scoped adapters run. The ladder is ordered most- to
 * least-specific; the first hit wins, so a precise street match is still
 * preferred whenever OSM has one.
 */
export function buildQueryLadder(rawAddress: string): string[] {
  const lines = rawAddress
    .split(/\r?\n/)
    .map((l) => normalizeWhitespace(l))
    .filter(Boolean);
  const full = normalizeWhitespace(rawAddress);
  const ladder: string[] = [];
  const push = (q: string) => {
    if (q && !ladder.includes(q)) ladder.push(q);
  };

  if (full) push(full);
  // The last line of a conventional US address is "City ST ZIP".
  if (lines.length > 1) push(lines[lines.length - 1]!);
  // Coarsest fallback: the bare 5-digit ZIP.
  const zip = full.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) push(`${zip[1]}, USA`);

  return ladder;
}

async function queryNominatim(
  q: string,
  signal?: AbortSignal,
): Promise<Geocode | null> {
  return enqueue(async () => {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "1");

    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Nominatim returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as NominatimResult[];
    const hit = json[0];
    if (!hit) return null;

    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const a = hit.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? null;
    const state = a.state ?? null;

    return {
      latitude: lat,
      longitude: lon,
      jurisdictionCity: city,
      jurisdictionState: state,
      jurisdictionFips: null, // Nominatim does not provide FIPS
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
      raw: hit,
    };
  });
}

/**
 * Geocode a US address to coordinates + a resolved city/state.
 *
 * Walks the broaden-on-miss ladder (full address → city/ZIP line → bare
 * ZIP) and returns the first hit. Returns `null` only when every rung
 * misses. A hard upstream error on one rung does not abort the ladder — a
 * coarser query may still succeed — but a caller-aborted signal ends it
 * immediately and rethrows.
 */
export async function geocodeAddress(
  address: string,
  opts: GeocodeOptions = {},
): Promise<Geocode | null> {
  const ladder = buildQueryLadder(address);
  if (ladder.length === 0) return null;

  let lastErr: unknown = null;
  let sawCleanMiss = false;
  for (const q of ladder) {
    if (opts.signal?.aborted) break;
    try {
      const hit = await queryNominatim(q, opts.signal);
      if (hit) return hit;
      sawCleanMiss = true; // Nominatim was reachable; it just had no match.
    } catch (err) {
      lastErr = err;
      // Caller cancelled — stop the ladder and surface the abort.
      if (opts.signal?.aborted) throw err;
    }
  }
  // If at least one rung came back as a clean "no match", the address is
  // genuinely unfindable — return null. Only throw when every rung errored,
  // so callers can distinguish "service unavailable" from "not found".
  if (!sawCleanMiss && lastErr) throw lastErr;
  return null;
}
