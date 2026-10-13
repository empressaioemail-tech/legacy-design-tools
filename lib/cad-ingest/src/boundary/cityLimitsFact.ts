/**
 * Typed city-limits serve DTO for inspect (P-76).
 *
 * Not an atom family. PIP against `tx_city_boundary` only.
 * ETJ is a typed absence (`etjStatus: unresolved`). A fabricated
 * offset / buffer ring is a defect — this module has no buffer path.
 */

import type {
  CityContainmentResult,
  EtjIncorporationSettlement,
  EtjStatus,
} from "./containment";
import {
  AREA_SHARE_METHOD,
  describeAreaShareSplit,
  isSliverPiece,
  MAJORITY_SHARE,
  SPLIT_DISCLOSURE_BELOW_SHARE,
  type AreaShareDecision,
  type AreaSharePiece,
} from "./areaShare";

export const CITY_LIMITS_SOURCE = "tx_city_boundary" as const;

export type CityLimitsStatus =
  | "incorporated"
  | "unincorporated"
  | "unmeasured";

/**
 * How the parcel's area divides among cities, served with the city-limits
 * answer so a surface can disclose a split ("93% in Horseshoe Bay, 7%
 * unincorporated"). Decided by `decideByAreaShare` (areaShare.ts).
 *
 * ADDITIVE AND OPTIONAL: a fact without it reads exactly as before, and every
 * existing consumer keys on `status` / `cityName` only. It is present when
 * the answer was decided by area share AND the record carried the decision;
 * a point answer (a county whose `cityLimits` rail is not slated) has no area
 * and never carries one.
 */
export type CityLimitsAreaShare = {
  method: typeof AREA_SHARE_METHOD;
  /** `majority` (> 50%) or `plurality` (no piece held a majority). */
  rule: "majority" | "plurality";
  /** The winning piece's share of the parcel, 0..1. */
  winnerShare: number;
  /** True when the split must be disclosed (winner < 99%, a non-sliver other piece). */
  split: boolean;
  /** The sentence to show when `split`; null otherwise. */
  disclosure: string | null;
  /** Every piece, largest first. `cityName: null` is the unincorporated remainder. */
  pieces: Array<{
    cityName: string | null;
    geoId: string | null;
    share: number;
    areaM2: number;
    sliver: boolean;
  }>;
};

export type CityLimitsFact = {
  status: CityLimitsStatus;
  etjStatus: EtjStatus;
  source: typeof CITY_LIMITS_SOURCE;
  basis: string;
  cityName?: string;
  geoId?: string;
  gnis?: string | null;
  areaShare?: CityLimitsAreaShare;
};

/** The served shape of an area-share decision. */
export function cityLimitsAreaShareFromDecision(
  decision: AreaShareDecision,
): CityLimitsAreaShare {
  return {
    method: decision.method,
    rule: decision.rule,
    winnerShare: decision.winner.share,
    split: decision.split,
    disclosure: decision.disclosure,
    pieces: decision.pieces.map((p) => ({
      cityName: p.kind === "jurisdiction" ? p.name : null,
      geoId: p.kind === "jurisdiction" ? p.id : null,
      share: p.share,
      areaM2: p.areaM2,
      sliver: p.sliver,
    })),
  };
}

function finiteInUnit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1.000001;
}

/**
 * Read an `areaShare` object off a parcel_record `cityLimits` cell (the value
 * cell itself, or an absent-verified cell's `basis`) and RE-DERIVE everything
 * that is derivable from its pieces, so a stored answer can never disagree
 * with its own numbers: `winnerShare`, `rule`, `split`, each piece's
 * `sliver` flag and the `disclosure` sentence are recomputed here from the
 * stored pieces with the same constants `decideByAreaShare` uses. The writer
 * only has to store `method` and `pieces`.
 *
 * Returns null — and the fact is served without a split, exactly as before —
 * when the object is missing, names another method, or is malformed (no
 * pieces, a share outside 0..1, a negative area, a winner that is not the
 * cell's own answer). A malformed split is never served and never invented.
 *
 * `expected` is the cell's own answer: the city name for a value cell, null
 * for an unincorporated (absent-verified) cell. The largest stored piece must
 * BE that answer; otherwise the split describes a different decision than the
 * one served and is dropped.
 */
export function parseCityLimitsAreaShare(
  raw: unknown,
  expected: { cityName: string | null },
): CityLimitsAreaShare | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.method !== AREA_SHARE_METHOD) return null;
  if (!Array.isArray(r.pieces) || r.pieces.length === 0) return null;
  const pieces: AreaSharePiece[] = [];
  for (const item of r.pieces) {
    if (!item || typeof item !== "object") return null;
    const it = item as Record<string, unknown>;
    const share = it.share;
    const areaM2 = it.areaM2;
    if (!finiteInUnit(share)) return null;
    if (typeof areaM2 !== "number" || !Number.isFinite(areaM2) || areaM2 < 0) return null;
    const cityName = typeof it.cityName === "string" && it.cityName.trim() ? it.cityName.trim() : null;
    const geoId = typeof it.geoId === "string" && it.geoId.trim() ? it.geoId.trim() : null;
    const sliver = isSliverPiece(share, areaM2);
    if (cityName === null) {
      pieces.push({ kind: "remainder", areaM2, share, sliver });
    } else {
      pieces.push({ kind: "jurisdiction", id: geoId ?? cityName, name: cityName, gnis: null, areaM2, share, sliver });
    }
  }
  pieces.sort((a, b) => b.share - a.share);
  const winner = pieces[0]!;
  const winnerCity = winner.kind === "jurisdiction" ? winner.name : null;
  if (winnerCity !== expected.cityName) return null;
  const split =
    winner.share < SPLIT_DISCLOSURE_BELOW_SHARE &&
    pieces.some((p) => p !== winner && !p.sliver);
  return {
    method: AREA_SHARE_METHOD,
    rule: winner.share > MAJORITY_SHARE ? "majority" : "plurality",
    winnerShare: winner.share,
    split,
    disclosure: split ? describeAreaShareSplit(pieces, "unincorporated") : null,
    pieces: pieces.map((p) => ({
      cityName: p.kind === "jurisdiction" ? p.name : null,
      geoId: p.kind === "jurisdiction" ? p.id : null,
      share: p.share,
      areaM2: p.areaM2,
      sliver: p.sliver,
    })),
  };
}

export function cityLimitsFactFromContainment(
  result: CityContainmentResult,
): CityLimitsFact {
  if (result.status === "incorporated") {
    return {
      status: "incorporated",
      etjStatus: result.etjStatus,
      source: CITY_LIMITS_SOURCE,
      basis: result.basis,
      cityName: result.cityName,
      geoId: result.geoId,
      gnis: result.gnis,
      ...(result.areaShare
        ? { areaShare: cityLimitsAreaShareFromDecision(result.areaShare) }
        : {}),
    };
  }
  return {
    status: result.status,
    etjStatus: result.etjStatus,
    source: CITY_LIMITS_SOURCE,
    basis: result.basis,
    ...(result.status === "unincorporated" && result.areaShare
      ? { areaShare: cityLimitsAreaShareFromDecision(result.areaShare) }
      : {}),
  };
}

export function unmeasuredCityLimitsFact(basis: string): CityLimitsFact {
  return {
    status: "unmeasured",
    etjStatus: "unresolved",
    source: CITY_LIMITS_SOURCE,
    basis,
  };
}

/** Degenerate bake centroid (0,0) and non-finite coords are not a query point. */
export function usableCityLimitsQueryPoint(
  longitude: number,
  latitude: number,
): { longitude: number; latitude: number } | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude === 0 && latitude === 0) return null;
  return { longitude, latitude };
}

/**
 * P-376: this city-limits fact's own incorporation determination, in the shape
 * the ETJ determination consumes — or null when this fact settles nothing.
 *
 * "A real basis" is THIS TYPE's state, not a new judgement:
 *
 *   - `incorporated` is a POSITIVE determination, and it has to NAME the city it
 *     rests on: an `incorporated` fact with no `cityName` would be a legal
 *     ground with no subject for it, so it settles nothing;
 *   - `unmeasured` never settles. It is this type's own "nothing usable was
 *     determined" state, and it is where EVERY parcel_record refusal collapses
 *     (unaccounted, malformed cell, no such parcel or rail, store not
 *     configured, engine refused, invalid node id), so a refusal can never
 *     invent an incorporation;
 *   - `unincorporated` never settles. It is the opposite determination, and the
 *     published-ring test is exactly the check that exists for it.
 *
 * The `source` and `basis` fields are carried verbatim rather than validated
 * here: `source` is a non-empty literal on this type, and `basis` is the
 * sentence that carries the source of record and the vintage. The sentence is
 * deliberately NOT re-parsed — a parser would be a second owner of a string this
 * type already owns — and the servability of the whole settlement (a city, a
 * source and a basis, all non-empty) is checked once, where it is served, in
 * `resolveEtjByIncorporation`.
 */
export function incorporationSettlesEtj(
  fact: CityLimitsFact | null,
): EtjIncorporationSettlement | null {
  if (fact === null || fact.status !== "incorporated") return null;
  const cityName = fact.cityName?.trim() ?? "";
  if (cityName.length === 0) return null;
  return {
    cityName,
    geoId: fact.geoId ?? null,
    source: fact.source,
    cityLimitsBasis: fact.basis,
  };
}
