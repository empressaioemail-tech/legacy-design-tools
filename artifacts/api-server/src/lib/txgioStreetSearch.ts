/**
 * Bare-street parcel set search. House-number prefix search stays on
 * situs-search. This path is the "everyone on Pine St" case.
 *
 * Locality or countyFips is required. An unbounded contains across the
 * store is the hang this refuse exists to prevent.
 *
 * Truncation is a field.
 */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, txgioParcel } from "@workspace/db";
import { parcelNodeId } from "./parcelNodeId";
import {
  buildNormalizedStreetSql,
  localityFromStoredAddress,
  normalizeStreetLine,
  parsePlaceSearchLocality,
  placeSearchLocalityMatches,
  situsSearchBareStreetVariants,
  texasCountyFipsList,
  type PlaceSearchLocality,
} from "./txgioAddressNormalize";

export const STREET_SEARCH_CAP = 50;

export type StreetSearchHit = {
  parcelNodeId: string;
  situsAddress: string;
  countyFips: string;
};

export type StreetSearchOk = {
  hits: StreetSearchHit[];
  cap: number;
  received: number;
  truncated: boolean;
  /** exact = every hit is the queried street. fuzzy = name-fragment match. */
  match: "exact" | "fuzzy";
  /** Distinct streets present in the returned hits. Empty when there are no hits. */
  streets: string[];
  /** Present only when match is fuzzy. Names the silence this field exists to kill. */
  matchBasis?: "name-fragment";
};

export type StreetSearchRefuse = {
  refused: true;
  code: "bare_street_unbounded" | "bare_street_not_a_street" | "street_search_timeout";
  reason: string;
};

export type StreetSearchResult = StreetSearchOk | StreetSearchRefuse;

export type StreetSearchDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

function escapeIlikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function normalizedColumnExpr(columnName: "situs_address") {
  return sql.raw(buildNormalizedStreetSql(columnName));
}

function spaceBoundedNeedles(variant: string) {
  const needle = escapeIlikeLiteral(variant);
  return [
    sql`${normalizedColumnExpr("situs_address")} ILIKE ${needle + "%"}`,
    sql`${normalizedColumnExpr("situs_address")} ILIKE ${"% " + needle + "%"}`,
    sql`${normalizedColumnExpr("situs_address")} ILIKE ${"% " + needle}`,
  ];
}

/** Street search answers or refuses within this budget (QA 2026-09-29, fix register C2). */
export const STREET_SEARCH_BUDGET_MS = 8000;

/** Counties a normalised city falls in, most parcels first, from the Factory's daily city_county_counts. */
async function countiesForCity(city: string): Promise<string[]> {
  try {
    const res = (await defaultDb.execute(
      sql`select county_fips from city_county_counts where city_normalised = ${city} order by parcel_count desc limit 3`,
    )) as unknown as { rows?: { county_fips: string }[] };
    // Was `/^d{5}$/` (a literal "ddddd" match -- never true for any real FIPS), which silently
    // emptied this function's result on EVERY call, re-opening the exact C2 unbounded-scan
    // timeout ("Water St, Bastrop") the city-counties narrowing was built to close, because the
    // caller's fallback to `texasCountyFipsList()` (all 254 counties) fired every time. Fixed to
    // the digit class; see test/txgioStreetSearch.test.ts's falsifier.
    return (res.rows ?? []).map((row) => row.county_fips).filter((f) => /^\d{5}$/.test(f));
  } catch {
    return [];
  }
}

/**
 * GATE 3 / ZIP-to-county ruling (operator, 2026-10-07): "The Census ZCTA-to-county
 * relationship file is the authority ... A split ZIP is never decided from the ZIP alone: the
 * address resolves to its parcel, and the parcel's county wins. The ZIP only narrows the
 * search; a split ZIP such as 78654 searches every county it touches."
 *
 * Every county the ZCTA overlaps AT ALL, from the Census relationship file
 * (`census_zcta_county_rel`, loaded by hauska-factory's `acquire-zcta-county.mjs`,
 * `source_vintage='2020'`) -- not truncated to a top-N like `countiesForCity`'s
 * parcel-count vote, because narrowing by an authoritative federal boundary file
 * is not the same risk as narrowing by our own sparse served rows (Phase 0 audit
 * section 3, P3: "ZIP-to-county is voted from our own sparse parcel rows: 53.6%
 * of 2,864 ZIPs were over-confident"). This function only NARROWS the candidate
 * counties scanned; each hit's actual county still comes from the parcel's own
 * `txgio_parcel.county_fips` row (below), never from this list.
 */
async function countiesForZip(zip: string): Promise<string[]> {
  try {
    const res = (await defaultDb.execute(
      sql`select county_fips from census_zcta_county_rel where zcta5 = ${zip}`,
    )) as unknown as { rows?: { county_fips: string }[] };
    return (res.rows ?? []).map((row) => row.county_fips).filter((f) => /^\d{5}$/.test(f));
  } catch {
    return [];
  }
}

function clampCap(raw: number | undefined): number {
  return Math.min(
    Math.max(Math.floor(raw ?? STREET_SEARCH_CAP), 1),
    STREET_SEARCH_CAP,
  );
}

export function sliceStreetHits(
  hits: StreetSearchHit[],
  cap: number,
): { hits: StreetSearchHit[]; truncated: boolean } {
  const truncated = hits.length > cap;
  return { hits: hits.slice(0, cap), truncated };
}

/** House-number-stripped street from a stored situs. Null if unparseable. */
export function streetNameFromSitus(situs: string): string | null {
  const line = normalizeStreetLine(situs);
  if (!line) return null;
  const tokens = line.split(" ").filter(Boolean);
  if (tokens.length < 2) return null;
  return tokens.slice(1).join(" ");
}

/**
 * Keep the broad PINE-token match. Declare it when the hits are not the
 * queried street. Falsifier: four fragment streets with match absent or exact.
 */
export function declareStreetMatch(
  hits: ReadonlyArray<StreetSearchHit>,
  query: string,
): Pick<StreetSearchOk, "match" | "streets" | "matchBasis"> {
  const variants = new Set(situsSearchBareStreetVariants(query));
  const streets: string[] = [];
  for (const hit of hits) {
    const name = streetNameFromSitus(hit.situsAddress);
    if (name && !streets.includes(name)) streets.push(name);
  }
  const exact =
    streets.length === 0 || streets.every((street) => variants.has(street));
  if (exact) return { match: "exact", streets };
  return { match: "fuzzy", streets, matchBasis: "name-fragment" };
}

export async function searchParcelsByBareStreet(input: {
  query: string;
  cap?: number;
  countyFips?: string;
  database?: StreetSearchDb;
  /** Test seam; defaults to city_county_counts. */
  resolveCityCounties?: (city: string) => Promise<string[]>;
  /** Test seam; defaults to census_zcta_county_rel. */
  resolveZipCounties?: (zip: string) => Promise<string[]>;
}): Promise<StreetSearchResult> {
  const variants = situsSearchBareStreetVariants(input.query);
  if (variants.length === 0) {
    return {
      refused: true,
      code: "bare_street_not_a_street",
      reason:
        "q is not a bare street. A house-number-prefixed query belongs on situs-search.",
    };
  }

  const locality = parsePlaceSearchLocality(input.query);
  const countyFips = input.countyFips?.trim() ?? "";
  const hasCounty = /^\d{5}$/.test(countyFips);
  const hasBound = Boolean(locality.city || locality.zip || hasCounty);
  if (!hasBound) {
    return {
      refused: true,
      code: "bare_street_unbounded",
      reason:
        "Bare street search requires a city, ZIP, or countyFips. Refusing an unbounded contains.",
    };
  }

  const cap = clampCap(input.cap);
  const database = input.database ?? defaultDb;
  const needleClauses = variants.flatMap(spaceBoundedNeedles);

  // A city with no county used to scan every Texas county with no index and
  // no time limit, so "Water St, Bastrop" timed out (fix register C2). Bound
  // the city to its counties first; keep the city filter when a county is given.
  const cityCounties =
    !hasCounty && locality.city ? await (input.resolveCityCounties ?? countiesForCity)(locality.city) : [];
  // ZIP-to-county ruling (2026-10-07): narrow by the Census ZCTA relationship file, never decide
  // from the ZIP alone. A split ZIP (78654: Burnet + Travis) searches every county it names here
  // -- the actual county served for each hit still comes from that parcel's own row below.
  const zipCounties =
    !hasCounty && locality.zip ? await (input.resolveZipCounties ?? countiesForZip)(locality.zip) : [];
  const localityFilters = [];
  if (hasCounty) {
    localityFilters.push(eq(txgioParcel.countyFips, countyFips));
    if (locality.city) {
      localityFilters.push(sql`strpos(upper(${txgioParcel.situsAddress}), ${locality.city}) > 0`);
    }
  } else {
    // Combine city and ZIP narrowing (either source that resolved counties bounds the scan;
    // when both resolve, search every county either one names -- a narrower intersection could
    // wrongly exclude a real county if the two sources disagree at the margin, and the ruling's
    // own words are "the ZIP only narrows the search", not "the ZIP and the city must agree on
    // the search"). Only when NEITHER resolves anything does this fall back to all 254 Texas
    // counties, same as before this change.
    const candidateCounties = Array.from(new Set([...cityCounties, ...zipCounties]));
    localityFilters.push(
      inArray(txgioParcel.countyFips, candidateCounties.length > 0 ? candidateCounties : texasCountyFipsList()),
    );
    if (locality.zip) {
      localityFilters.push(
        sql`${txgioParcel.situsAddress} ~ ${`\\m${locality.zip}\\M`}`,
      );
    }
    if (locality.city) {
      localityFilters.push(
        sql`strpos(upper(${txgioParcel.situsAddress}), ${locality.city}) > 0`,
      );
    }
  }

  const query = database
    .select({
      countyFips: txgioParcel.countyFips,
      propId: txgioParcel.propId,
      situsAddress: txgioParcel.situsAddress,
    })
    .from(txgioParcel)
    .where(
      and(
        needleClauses.length === 1 ? needleClauses[0]! : or(...needleClauses),
        ...localityFilters,
      ),
    )
    // Over-fetch: several tile rows can belong to one parcel, so a cap+1 limit
    // before de-duplication under-filled the set and misreported truncation.
    .limit((cap + 1) * 4) as unknown as Promise<
    { countyFips: string | null; propId: string | null; situsAddress: string | null }[]
  >;
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    query,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), STREET_SEARCH_BUDGET_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (raced === timedOut) {
    return {
      refused: true,
      code: "street_search_timeout",
      reason: "The street search did not finish in time. Add a ZIP or a county to narrow it.",
    };
  }
  // The queried street first, then fragment matches (WATER ST before COOL WATER DR).
  const primary = variants[0]!;
  const rows = [...raced].sort((a, b) => {
    const rank = (situs: string | null) => (situs && streetNameFromSitus(situs) === primary ? 0 : 1);
    return rank(a.situsAddress) - rank(b.situsAddress);
  });

  const byParcel = new Map<string, StreetSearchHit>();
  for (const r of rows) {
    const fips = r.countyFips?.trim();
    const propId = r.propId?.trim();
    const situs = r.situsAddress?.trim();
    if (!fips || !propId || !situs) continue;
    if (
      (locality.city || locality.zip) &&
      !placeSearchLocalityMatches(localityFromStoredAddress(situs), locality)
    ) {
      continue;
    }
    const nodeId = parcelNodeId(fips, propId);
    if (!nodeId) continue;
    if (!byParcel.has(nodeId)) {
      byParcel.set(nodeId, {
        parcelNodeId: nodeId,
        situsAddress: situs,
        countyFips: fips,
      });
    }
  }

  const { hits, truncated } = sliceStreetHits(
    [...byParcel.values()],
    cap,
  );
  return {
    hits,
    cap,
    received: hits.length,
    truncated,
    ...declareStreetMatch(hits, input.query),
  };
}

export type { PlaceSearchLocality };
