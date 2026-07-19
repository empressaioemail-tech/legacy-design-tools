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

import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, txgioParcel, txgioAddress } from "@workspace/db";
import {
  pointInGeometry,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";
import { parcelNodeId } from "./parcelNodeId";
import {
  normalizeStreetLine,
  normalizeStreetLineCandidates,
  buildNormalizedStreetSql,
} from "./txgioAddressNormalize";

/** Re-exported so existing import sites keep working; defined in the
 *  dependency-free `./txgioAddressNormalize` so its pure logic can be
 *  unit-tested without pulling in `@workspace/db`. */
export { normalizeStreetLine };

/** Narrow db surface — injectable for tests (mirrors TxgioStoreDb). */
export type TxgioAddressResolveDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

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
 * Outcome of the F4e disambiguating, multi-county situs resolve. Exactly
 * one of `hit` / `declined` is meaningful:
 *
 *   - `hit` set  : an AUTHORITATIVE parcel — either a situs that was
 *     unique across all candidate counties, or an ambiguous situs the
 *     geocoded point disambiguated to a single containing candidate.
 *     `resolvedBy` records which.
 *   - `hit` null : no authoritative parcel. `reason` distinguishes an
 *     honest situs MISS (fall through to the geocode/rooftop path) from
 *     an ambiguous situs that the point could NOT disambiguate
 *     (`ambiguous-*` — the caller must DECLINE, never blind-point-guess a
 *     wrong-situs neighbor; commitment #1).
 *
 * Empty-situs parcels (`, ,`) never appear here: the normalizer rejects a
 * house-numberless query key, and the stored empty situs normalizes to a
 * key no house-numbered query can equal.
 */
export interface SitusResolveOutcome {
  hit: AddressResolveHit | null;
  /** Why `hit` is null (only when it is). */
  reason?:
    | "no-situs-match"
    | "ambiguous-no-point"
    | "ambiguous-no-containing-candidate"
    | "ambiguous-multiple-containing-candidates";
  /** How a non-null `hit` was reached — provenance for logging. */
  resolvedBy?: "unique-situs" | "point-disambiguated";
  /** Distinct candidate prop-id count for an ambiguous decline (logging). */
  ambiguousCandidateCount?: number;
}

/** One store county to search + point-disambiguate against. */
export interface SitusCandidateCounty {
  fips: string;
}

interface SitusCandidate {
  countyFips: string;
  propId: string;
  geometry: unknown;
}

/**
 * SQL expression that normalizes a stored situs/full_addr column to the
 * SAME canonical street-line `normalizeStreetLine()` produces for the
 * query, so the comparison is apples-to-apples — SYMMETRICALLY, including
 * street-type + directional canonicalization (the store carries ~13k
 * SPELLED-OUT types like "144 THOMAS PLACE"; abbreviation-only column
 * normalization silently missed them). The expression is generated by
 * `buildNormalizedStreetSql()` from the same token maps the JS normalizer
 * uses, so the two cannot drift, and it matches the functional indexes
 * added in migration 0058 byte-for-byte (both build the expression from
 * that one function).
 *
 * `columnName` is the raw column identifier for the target table
 * (`"situs_address"` or `"full_addr"`); the caller passes the literal
 * so the generated SQL text is stable and index-matching.
 */
function normalizedColumnExpr(columnName: string) {
  return sql.raw(buildNormalizedStreetSql(columnName));
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
  const keys = normalizeStreetLineCandidates(input.address);
  if (keys.length === 0) return null;
  const database = input.database ?? defaultDb;

  const rows = (await database
    .select({ propId: txgioParcel.propId })
    .from(txgioParcel)
    .where(
      and(
        eq(txgioParcel.countyFips, input.countyFips.trim()),
        inArray(normalizedColumnExpr("situs_address"), keys),
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
 * F4e authoritative situs resolve — the class that finishes F4d. It fixes
 * three residual wrong-parcel / false-decline modes the single-county,
 * unique-only `resolveParcelBySitus` above left open:
 *
 *   1. SHARED-SITUS AMBIGUITY. When several parcels share a situs string
 *      (Hays ~14%, Comal ~5% of situs-bearing parcels), the old resolver
 *      returned null and the route blind-pin-queried the geocode point —
 *      which happily returns a real, adjacent, DIFFERENTLY-ADDRESSED
 *      parcel (e.g. a query for "145 Texas Agate Dr" pinned the neighbor
 *      whose situs is "AMYTHEST DR"). Here we DISAMBIGUATE instead: among
 *      the ambiguous-situs candidates, pick the one whose POLYGON CONTAINS
 *      the geocoded point. Exactly one containing candidate -> that's the
 *      authoritative answer (right situs AND right geometry). None or
 *      several containing -> DECLINE (`hit: null`, `reason: ambiguous-*`);
 *      we NEVER return a wrong-situs neighbor. The point is used only to
 *      choose AMONG situs-correct candidates, never to grab a parcel whose
 *      situs does not match the query.
 *
 *   2. MULTI-COUNTY. County routing bboxes overlap at county lines and
 *      nearest-centroid can pick the WRONG store county (a Hays address
 *      near the Comal line routed to Comal, found nothing, declined). We
 *      search situs across ALL candidate counties in one indexed query; a
 *      UNIQUE hit in ANY of them is authoritative and wins over centroid
 *      distance. (Bounded to the 2 store counties today.)
 *
 *   3. SITUS-BEFORE-GEOCODE. A unique situs (or a point-disambiguated
 *      ambiguous situs) is HIGHER authority than any geocode. This
 *      resolver takes an OPTIONAL point: a unique hit needs no point at
 *      all, so it resolves even when the geocode entirely MISSED — the
 *      caller runs this BEFORE the geocode-quality / geocode-miss gate.
 *
 * INDEX: the situs comparison uses the SAME `normalizedColumnExpr(
 * "situs_address")` the unique resolver uses, now with an `IN (counties)`
 * predicate on `county_fips`. The functional index (migration 0058) is on
 * `(county_fips, <normalized expr>)`, so Postgres still uses it — an
 * equality on the normalized expression combined with a small `IN` list on
 * the leading `county_fips` column is an index/bitmap scan, not a seq scan.
 *
 * Point-in-polygon runs in JS over the SMALL ambiguous candidate set
 * (a handful of parcels), reusing the shared `pointInGeometry` ray-cast
 * (`@workspace/cad-ingest/txgio-geo`) — the same helper the store's pin
 * lookup uses. No PostGIS.
 */
export async function resolveParcelBySitusDisambiguated(input: {
  counties: SitusCandidateCounty[];
  address: string;
  /** Geocoded point, when available — used ONLY to disambiguate an
   *  ambiguous situs among situs-correct candidates. Omit when the geocode
   *  missed; a unique situs still resolves. */
  point?: { latitude: number; longitude: number } | null;
  database?: TxgioAddressResolveDb;
}): Promise<SitusResolveOutcome> {
  const keys = normalizeStreetLineCandidates(input.address);
  if (keys.length === 0) return { hit: null, reason: "no-situs-match" };
  const database = input.database ?? defaultDb;

  const fipsList = [
    ...new Set(
      input.counties.map((c) => c.fips.trim()).filter((f) => f.length > 0),
    ),
  ];
  if (fipsList.length === 0) return { hit: null, reason: "no-situs-match" };

  // ONE indexed query across all candidate counties. Pull geometry too so
  // an ambiguous match can be point-disambiguated without a second round
  // trip; the ambiguous set is a handful of rows, so the geometry payload
  // is small.
  const rows = (await database
    .select({
      countyFips: txgioParcel.countyFips,
      propId: txgioParcel.propId,
      geometry: txgioParcel.geometry,
    })
    .from(txgioParcel)
    .where(
      and(
        inArray(txgioParcel.countyFips, fipsList),
        inArray(normalizedColumnExpr("situs_address"), keys),
      ),
    )) as {
    countyFips: string | null;
    propId: string | null;
    geometry: unknown;
  }[];

  // Distinct (county, propId) candidates — rows are duplicated one-per-
  // tile-cell in the store, so dedupe. Empty/absent prop ids can't identify
  // a parcel and are skipped (never a fabricated node id).
  const byKey = new Map<string, SitusCandidate>();
  for (const r of rows) {
    const fips = r.countyFips?.trim();
    const propId = r.propId?.trim();
    if (!fips || !propId) continue;
    const k = `${fips}:${propId}`;
    if (!byKey.has(k)) {
      byKey.set(k, { countyFips: fips, propId, geometry: r.geometry });
    }
  }
  const candidates = [...byKey.values()];

  if (candidates.length === 0) return { hit: null, reason: "no-situs-match" };

  // UNIQUE across every candidate county -> authoritative, no point needed
  // (wins over any geocode; item 2 + item 3).
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const nodeId = parcelNodeId(only.countyFips, only.propId);
    if (!nodeId) return { hit: null, reason: "no-situs-match" };
    return {
      hit: {
        parcelNodeId: nodeId,
        rawPropId: only.propId,
        matchSource: "situs",
      },
      resolvedBy: "unique-situs",
    };
  }

  // AMBIGUOUS (>1 distinct parcel share the situs; item 1). Disambiguate by
  // the geocoded point: keep only situs-correct candidates whose polygon
  // CONTAINS the point.
  if (
    !input.point ||
    !Number.isFinite(input.point.latitude) ||
    !Number.isFinite(input.point.longitude)
  ) {
    // No point to disambiguate with -> DECLINE (never guess between the
    // situs-correct candidates, and never fall to a wrong-situs neighbor).
    return {
      hit: null,
      reason: "ambiguous-no-point",
      ambiguousCandidateCount: candidates.length,
    };
  }

  const { latitude, longitude } = input.point;
  const containing = candidates.filter((c) =>
    pointInGeometry(longitude, latitude, c.geometry as GeoJsonGeometry),
  );

  if (containing.length === 1) {
    const pick = containing[0]!;
    const nodeId = parcelNodeId(pick.countyFips, pick.propId);
    if (!nodeId) {
      return {
        hit: null,
        reason: "ambiguous-no-containing-candidate",
        ambiguousCandidateCount: candidates.length,
      };
    }
    return {
      hit: {
        parcelNodeId: nodeId,
        rawPropId: pick.propId,
        matchSource: "situs",
      },
      resolvedBy: "point-disambiguated",
    };
  }

  // None or several situs-correct candidates contain the point (e.g. stacked
  // overlapping parcels, or a centroid geocode that falls in no candidate) ->
  // DECLINE honestly. This is CORRECT (commitment #1): an honest decline
  // beats returning a wrong parcel.
  return {
    hit: null,
    reason:
      containing.length === 0
        ? "ambiguous-no-containing-candidate"
        : "ambiguous-multiple-containing-candidates",
    ambiguousCandidateCount: candidates.length,
  };
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
  const keys = normalizeStreetLineCandidates(input.address);
  if (keys.length === 0) return null;
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
        inArray(normalizedColumnExpr("full_addr"), keys),
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
