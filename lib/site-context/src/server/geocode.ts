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

export async function geocodeAddress(
  address: string,
  opts: GeocodeOptions = {},
): Promise<Geocode | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;

  return enqueue(async () => {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "1");

    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: opts.signal,
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
