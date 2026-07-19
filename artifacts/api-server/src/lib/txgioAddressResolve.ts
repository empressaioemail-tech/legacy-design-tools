/**
 * Authoritative address -> parcel resolution over the self-hosted
 * TxGIO stores (F4d).
 *
 * WHY THIS EXISTS. The buildable-envelope route used to resolve an
 * address to a parcel by geocoding it (OSM/Nominatim) to a lat/lng and
 * then finding the parcel polygon that contains that point. Nominatim
 * silently DEGRADES on a house-number miss: `geocode.ts`'s broaden-on-
 * miss ladder walks full-address -> "City ST ZIP" -> bare ZIP and takes
 * the first hit, and the returned `Geocode` carries NO signal about
 * which rung produced it. A ZIP- or city-centroid hit therefore looks
 * exactly like a rooftop hit, lands kilometres from the real rooftop,
 * falls inside NO parcel (or the wrong one), and the whole flow reports
 * a "miss" for an address whose parcel is sitting right there in the
 * store. Proven: `6026 Marsh Ln, Buda, TX 78610` reported
 * `parcel-unavailable`, yet the parcel EXISTS as node `48209:193340`
 * (situs "6026 MARSH LN, BUDA, TX 78610") and its true coordinate
 * resolves correctly.
 *
 * The county's AUTHORITATIVE address data is already ingested in the
 * SAME database and never consulted:
 *
 *   - `txgio_parcel.situs_address` is the appraisal-district situs
 *     string ("6026 MARSH LN, BUDA, TX 78610"), and the row's `prop_id`
 *     is exactly the node-id suffix. A normalized string match against
 *     situs yields the parcel AND its `parcel_node_id` DIRECTLY — no
 *     geocode, no point-in-polygon.
 *
 *   - `txgio_address` (TxGIO/StratMap statewide Address Points) carries
 *     the AUTHORITATIVE ROOFTOP coordinate for a delivery point, keyed
 *     `(county_fips, full_addr, unit)`. It has no prop-id link, so it
 *     resolves a rooftop lat/lng to feed point-in-parcel — strictly
 *     better than a fuzzy geocode because it is the county's own
 *     rooftop point, not an OSM interpolation.
 *
 * RESOLUTION PREFERENCE (highest authority first):
 *   (i)   explicit request lat/lng — honored verbatim, no geocode.
 *   (ii)  situs-string match against `txgio_parcel` -> parcel node
 *         directly (only when it collapses to ONE prop id).
 *   (iii) `txgio_address` rooftop-coordinate match -> point-in-parcel.
 *   (iv)  fuzzy geocode (Nominatim) — LAST resort, and the caller must
 *         treat a non-rooftop rung as low confidence (never silently
 *         resolve the wrong parcel from a centroid).
 *
 * This module owns (ii) and (iii). The route wires them ahead of the
 * geocode and keeps the geocode as the honest fallback.
 *
 * MATCH ROBUSTNESS. Appraisal situs and StratMap `full_addr` both use
 * USPS-style street-type ABBREVIATIONS (LN, ST, DR, CIR, TRL, ...), the
 * same style a typed query rarely uses ("Lane"/"Street"/"Drive"). The
 * normalizer folds case, collapses whitespace, strips punctuation, drops
 * a trailing unit, and canonicalizes street-type + directional words to
 * the abbreviation, so "6026 Marsh Lane" and "6026 MARSH LN" compare
 * equal. The comparison is done in SQL against a normalized expression
 * so the match is index-friendly-ish (still a scan, but bounded to the
 * county) and consistent with what we store.
 */

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, txgioParcel, txgioAddress } from "@workspace/db";
import { parcelNodeId } from "./parcelNodeId";

/** Narrow db surface — injectable for tests (mirrors TxgioStoreDb). */
export type TxgioAddressResolveDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

/** USPS street-type synonyms -> canonical abbreviation (uppercase). */
const STREET_TYPE_ABBR: Record<string, string> = {
  ALLEY: "ALY",
  ALY: "ALY",
  AVENUE: "AVE",
  AVE: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  BLVD: "BLVD",
  BEND: "BND",
  BND: "BND",
  CIRCLE: "CIR",
  CIR: "CIR",
  COURT: "CT",
  CT: "CT",
  COVE: "CV",
  CV: "CV",
  CROSSING: "XING",
  XING: "XING",
  DRIVE: "DR",
  DR: "DR",
  EXPRESSWAY: "EXPY",
  EXPY: "EXPY",
  HIGHWAY: "HWY",
  HWY: "HWY",
  HOLLOW: "HOLW",
  HOLW: "HOLW",
  LANE: "LN",
  LN: "LN",
  LOOP: "LOOP",
  PARKWAY: "PKWY",
  PKWY: "PKWY",
  PASS: "PASS",
  PATH: "PATH",
  PLACE: "PL",
  PL: "PL",
  PLAZA: "PLZ",
  PLZ: "PLZ",
  POINT: "PT",
  PT: "PT",
  RIDGE: "RDG",
  RDG: "RDG",
  ROAD: "RD",
  RD: "RD",
  ROW: "ROW",
  RUN: "RUN",
  SQUARE: "SQ",
  SQ: "SQ",
  STREET: "ST",
  ST: "ST",
  TERRACE: "TER",
  TER: "TER",
  TRACE: "TRCE",
  TRCE: "TRCE",
  TRAIL: "TRL",
  TRL: "TRL",
  TURNPIKE: "TPKE",
  TPKE: "TPKE",
  WAY: "WAY",
};

/** Directional synonyms -> canonical abbreviation. */
const DIRECTIONAL_ABBR: Record<string, string> = {
  NORTH: "N",
  N: "N",
  SOUTH: "S",
  S: "S",
  EAST: "E",
  E: "E",
  WEST: "W",
  W: "W",
  NORTHEAST: "NE",
  NE: "NE",
  NORTHWEST: "NW",
  NW: "NW",
  SOUTHEAST: "SE",
  SE: "SE",
  SOUTHWEST: "SW",
  SW: "SW",
};

/** Secondary-unit designators — everything from here on is a unit. */
const UNIT_DESIGNATORS = new Set([
  "APT",
  "APARTMENT",
  "UNIT",
  "STE",
  "SUITE",
  "BLDG",
  "BUILDING",
  "FL",
  "FLOOR",
  "RM",
  "ROOM",
  "SPC",
  "SPACE",
  "TRLR",
  "LOT",
  "#",
]);

/**
 * Normalize an address to a canonical `"{number} {street}"` token stream
 * for equality comparison against a stored situs/full_addr. Drops any
 * trailing city/state/zip (so a typed "6026 Marsh Ln, Buda, TX 78610"
 * still compares against the store's "6026 MARSH LN"), a trailing unit,
 * and canonicalizes street-type + directional words to their USPS
 * abbreviation.
 *
 * Returns null when there is nothing usable (no leading house number).
 */
export function normalizeStreetLine(raw: string): string | null {
  if (!raw) return null;
  // Take the FIRST comma-delimited segment — the street line. A typed
  // full address ("6026 Marsh Ln, Buda, TX 78610") and a bare street
  // line both reduce to the same street tokens this way, and a stored
  // situs that DOES carry city/state ("6026 MARSH LN, BUDA, TX 78610")
  // is normalized the same way when we build its comparison key.
  const firstSegment = raw.split(",")[0] ?? raw;
  const cleaned = firstSegment
    .toUpperCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  // Must start with a house number (the situs/full_addr store both do).
  // Addresses with no leading number (e.g. a bare street or the empty
  // ", ," situs) are not matchable this way -> null.
  if (!/^\d/.test(tokens[0]!)) return null;

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Stop at a secondary-unit designator (and its value): the store's
    // street label does not carry the unit inline.
    if (UNIT_DESIGNATORS.has(t) || t.startsWith("#")) break;
    const canonical =
      DIRECTIONAL_ABBR[t] ??
      STREET_TYPE_ABBR[t] ??
      t;
    out.push(canonical);
  }
  if (out.length < 2) return null; // need at least number + one street token
  return out.join(" ");
}

export interface AddressResolveHit {
  /** Canonical parcel node id, `{fips}:{normalizedPropId}` — map identity. */
  parcelNodeId: string;
  /** RAW appraisal prop id as stored in `txgio_parcel.prop_id` (leading
   *  zeros intact) — the key to fetch the parcel's geometry by. */
  rawPropId: string;
  /** How the parcel was resolved. */
  matchSource: "situs";
}

export interface RooftopHit {
  latitude: number;
  longitude: number;
  matchSource: "txgio-address";
}

/**
 * SQL expression that normalizes a stored situs/full_addr column to the
 * same canonical street-line the `normalizeStreetLine()` helper produces
 * for the query, so the comparison is apples-to-apples. Mirrors the JS
 * normalizer's shape:
 *   - take the substring before the first comma (drop city/state/zip),
 *   - uppercase, strip periods, collapse whitespace, trim.
 * Street-type / directional canonicalization is NOT reproduced in SQL —
 * instead the QUERY is expanded to the small set of stored spellings the
 * store actually uses (abbreviation is the store's own style, so the
 * abbreviated query key matches directly). See `situsMatchKeys()`.
 */
function normalizedColumnExpr(column: unknown) {
  return sql<string>`upper(trim(regexp_replace(regexp_replace(split_part(${column}, ',', 1), '[.]', '', 'g'), '\\s+', ' ', 'g')))`;
}

/**
 * Resolve an address DIRECTLY to a parcel node id by matching the
 * normalized street line against `txgio_parcel.situs_address` within the
 * county. Returns the hit ONLY when the match collapses to exactly ONE
 * distinct prop id (rows are duplicated one-per-tile-cell in the store,
 * so several rows for the same parcel are expected and deduped). An
 * ambiguous match (two different parcels share a situs string) or no
 * match returns null, and the caller falls through to the rooftop /
 * geocode path — we never guess between two parcels.
 */
export async function resolveParcelBySitus(input: {
  countyFips: string;
  address: string;
  database?: TxgioAddressResolveDb;
}): Promise<AddressResolveHit | null> {
  const key = normalizeStreetLine(input.address);
  if (!key) return null;
  const database = input.database ?? defaultDb;

  const rows = (await database
    .select({ propId: txgioParcel.propId })
    .from(txgioParcel)
    .where(
      and(
        eq(txgioParcel.countyFips, input.countyFips.trim()),
        eq(normalizedColumnExpr(txgioParcel.situsAddress), key),
      ),
    )) as { propId: string | null }[];

  const propIds = new Set<string>();
  for (const r of rows) {
    if (r.propId && r.propId.trim()) propIds.add(r.propId.trim());
  }
  if (propIds.size !== 1) return null; // no match, or ambiguous

  const propId = [...propIds][0]!;
  const nodeId = parcelNodeId(input.countyFips.trim(), propId);
  if (!nodeId) return null;
  return { parcelNodeId: nodeId, rawPropId: propId, matchSource: "situs" };
}

/**
 * Resolve an address to the county's AUTHORITATIVE rooftop coordinate by
 * matching the normalized street line against `txgio_address.full_addr`
 * within the county. Returns the rooftop lat/lng to feed point-in-parcel
 * (strictly better than a fuzzy geocode). Ambiguous (multiple distinct
 * rooftop points for the same normalized label, e.g. a multi-unit
 * building whose units sit at meaningfully different points) or no match
 * returns null. When several rows share the SAME point (the common
 * multi-unit case), any one is returned — the point is identical.
 */
export async function resolveRooftopByAddress(input: {
  countyFips: string;
  address: string;
  database?: TxgioAddressResolveDb;
}): Promise<RooftopHit | null> {
  const key = normalizeStreetLine(input.address);
  if (!key) return null;
  const database = input.database ?? defaultDb;

  const rows = (await database
    .select({
      latitude: txgioAddress.latitude,
      longitude: txgioAddress.longitude,
    })
    .from(txgioAddress)
    .where(
      and(
        eq(txgioAddress.countyFips, input.countyFips.trim()),
        eq(normalizedColumnExpr(txgioAddress.fullAddr), key),
      ),
    )) as { latitude: number; longitude: number }[];

  if (rows.length === 0) return null;

  // Collapse to distinct rounded points. Multi-unit buildings repeat the
  // label at one point (fine); meaningfully different points for the same
  // label are ambiguous and we decline to pick.
  const distinct = new Map<string, { latitude: number; longitude: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    const k = `${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}`;
    if (!distinct.has(k)) distinct.set(k, r);
  }
  if (distinct.size !== 1) return null;
  const point = [...distinct.values()][0]!;
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    matchSource: "txgio-address",
  };
}

/** Exposed for unit tests. */
export const __internal = { normalizedColumnExpr };
