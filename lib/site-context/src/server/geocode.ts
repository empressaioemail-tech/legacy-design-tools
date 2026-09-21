import type { Geocode, GeocodeMatchRung } from "../types";

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
  house_number?: string;
  road?: string;
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
  /**
   * Nominatim's own feature class/type for the hit ("place"/"house",
   * "place"/"postcode", "boundary"/"administrative", …). Read by
   * {@link effectiveMatchRung}: the hit's OWN precision decides the rung
   * the caller is told about (P-393).
   */
  class?: string;
  type?: string;
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
/** One rung of the geocode ladder: the query plus how precise a hit on
 *  it would be (see {@link GeocodeMatchRung}). */
export interface GeocodeLadderRung {
  q: string;
  rung: GeocodeMatchRung;
}

/**
 * The precision of a geocode is a property of the ANSWER, not of the QUERY
 * (P-393).
 *
 * `buildQueryLadderLabelled` labels each rung from the SHAPE of its query —
 * "starts with a house number" ⇒ `"street"`. Nominatim, however, is free to
 * answer a house-number query with a COARSER feature: when the house is not
 * in its index it falls back to the street, the locality, or — as measured
 * for `8459 ROCK CREEK RD, WACO, TX 76708` — the POSTCODE node
 * (`class:"place"`, `type:"postcode"`). Stamping that answer with the
 * query's rung told every consumer "rooftop-grade" about a point that is the
 * ZIP centroid, so `brokeragePlaceBuildableEnvelope`'s geocode-centroid gate
 * (`pointConfidence === "geocode-low"`) could not fire and a point ~3.5 km
 * from the parcel was used as the front-edge reference. The answer's own
 * precision therefore caps the rung — it can only ever LOWER it, never raise
 * it, so a coarser query can never be relabelled as a precise one.
 *
 * Callers see the honest rung; the coordinates are unchanged (a re-walk
 * would return the same coarse centroid from an even coarser query).
 */
export function effectiveMatchRung(
  queriedRung: GeocodeMatchRung,
  hit: Pick<NominatimResult, "class" | "type" | "address">,
): GeocodeMatchRung {
  // Coarser rungs are already honest about themselves.
  if (queriedRung !== "street") return queriedRung;
  // A house-number-grade answer keeps the street claim: either Nominatim's
  // own class/type says it is a building, or it hands back a house number.
  const houseGrade =
    hit.type === "house" ||
    (typeof hit.address?.house_number === "string" &&
      hit.address.house_number.trim() !== "");
  if (houseGrade) return "street";
  // A ROAD-CLASS answer is still a street match, and it is a DIFFERENT claim
  // from a centroid: the query named a street and Nominatim found that street
  // (`class:"highway"`). It is not rooftop-grade, but it is the address's own
  // frontage, and the drawing side already bounds what a road may be (see
  // `ROAD_TRUST_MAX_M` in the buildable-envelope edge labeling). Downgrading
  // it here would decline draws whose street rung answered with the road —
  // measured at 4 of the 33 corpus addresses on 2026-09-20 — for no honesty
  // gain, so it keeps the label it earns.
  if (hit.class === "highway") return "street";
  // Everything else answered a street query with a CENTROID — a postcode
  // node is the ZIP centroid (measured 3,512 m from parcel 48309:103015),
  // anything else is locality-grade at best. Those cannot be this parcel, so
  // the caller's centroid gate must be able to see them.
  return hit.type === "postcode" ? "zip" : "locality";
}

/**
 * Labelled ladder — each rung carries its {@link GeocodeMatchRung} so a
 * hit can report whether it was a rooftop-grade street match or a coarser
 * locality/ZIP centroid. The full street address is the only "street"
 * rung; a trailing "City ST ZIP" line is "locality"; the bare ZIP is
 * "zip". This label is the QUERY's shape: what the caller is told is the
 * hit's own precision, which can only lower it — see
 * {@link effectiveMatchRung}. Callers that only want the strings use
 * {@link buildQueryLadder}.
 */
export function buildQueryLadderLabelled(
  rawAddress: string,
): GeocodeLadderRung[] {
  const lines = rawAddress
    .split(/\r?\n/)
    .map((l) => normalizeWhitespace(l))
    .filter(Boolean);
  const full = normalizeWhitespace(rawAddress);
  const ladder: GeocodeLadderRung[] = [];
  const push = (q: string, rung: GeocodeMatchRung) => {
    if (q && !ladder.some((r) => r.q === q)) ladder.push({ q, rung });
  };

  // The full address is a rooftop-grade "street" query ONLY when it
  // carries a house number; a bare "City ST ZIP" typed as the whole
  // address is a locality centroid, not a rooftop.
  if (full) push(full, /^\s*\d/.test(full) ? "street" : "locality");
  // The last line of a conventional US address is "City ST ZIP".
  if (lines.length > 1) push(lines[lines.length - 1]!, "locality");
  // Coarsest fallback: the bare 5-digit ZIP.
  const zip = full.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) push(`${zip[1]}, USA`, "zip");

  return ladder;
}

/** Query-string-only ladder (back-compat). */
export function buildQueryLadder(rawAddress: string): string[] {
  return buildQueryLadderLabelled(rawAddress).map((r) => r.q);
}

async function queryNominatim(
  q: string,
  rung: GeocodeMatchRung,
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
      // The ANSWER's precision caps the label the query's shape asked for
      // (P-393) — a street query answered with the ZIP centroid must not be
      // reported as rooftop-grade.
      matchRung: effectiveMatchRung(rung, hit),
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
  const ladder = buildQueryLadderLabelled(address);
  if (ladder.length === 0) return null;

  let lastErr: unknown = null;
  let sawCleanMiss = false;
  for (const { q, rung } of ladder) {
    if (opts.signal?.aborted) break;
    try {
      const hit = await queryNominatim(q, rung, opts.signal);
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
