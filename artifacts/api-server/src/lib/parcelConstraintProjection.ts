/**
 * P-106 item 2. The projection: baked facets -> one cell per rail per parcel,
 * each cell carrying a VALUE and a DISPOSITION.
 *
 * This module is the DERIVATION ONLY. It is pure: bake payload in, cells out.
 * It never reads a store, never writes one, and never re-derives a facet from
 * source. The rail dispositions come from `r1BriefCompose`'s own predicates
 * (`zoningDisposition`, `landUseDisposition`) and from `smartSiteStub`'s rail
 * vocabulary, so the projection and `get_smart_site` cannot disagree about
 * what "present" means: there is one derivation, read at three depths now
 * instead of two.
 *
 * WHY A PROJECTION AND NOT A QUERY OVER THE BAKE. `place_layer_snapshots`
 * indexes `(adapter_key, place_key)` and `(adapter_key, lat_rounded,
 * lng_rounded)` and nothing on `payload_json`, so a filter over an attribute
 * is a scan of every row in the county. The projection is a cache, and a
 * cache that cannot say when it was built is a claim with its timestamp
 * missing, so every row carries `builtAt` and every response repeats it.
 *
 * THE THREE STATES ARE NOT TWO. A rail cell is `present` (a determination),
 * `absent-verified` (a POSITIVE determination that there is nothing to
 * report, with a basis), or one of `unknown` / `unread` / `refused`, which
 * are the three ways of not having looked or not having been answered.
 * Collapsing any of those into `absent-verified` fabricates a claim, and
 * collapsing `absent-verified` into "missing" hides parcels that qualify.
 * The five words are `smartSiteStub`'s own `SMART_SITE_RAIL_STATES`, imported
 * rather than retyped.
 */

import { landUseDisposition, zoningDisposition } from "./r1BriefCompose";
import {
  SMART_SITE_RAIL_STATES,
  type SmartSiteRailState,
} from "./smartSiteStub";
import { isPunctuationOnlySitus } from "./situsCompose";

export const CONSTRAINT_RAIL_STATES = SMART_SITE_RAIL_STATES;

/**
 * The v1 rail set, in the card's own order. `county` is the projection's key
 * and is not a rail. `etj` IS declared here and has NO source table in the
 * deployment store as of 2026-09-02: the store carries `tx_city_boundary`,
 * `tx_county_boundary`, `tx_special_district` and
 * `landing_parcel_jurisdiction`, and nothing carries an extraterritorial
 * jurisdiction ring. It is carried as a declared-ahead rail per
 * `_decisions/2026-09-01_parcel_record_rails_v2_template.md`: the column
 * exists so "we do not carry this" stays distinguishable from "this parcel
 * does not have it", its state is `unread` on every row, and every filter
 * over it is refused. A declared-ahead rail never enters a coverage number
 * as live.
 */
export const CONSTRAINT_RAILS = [
  "acreage",
  "landUse",
  "cityLimits",
  "etj",
  "zoningDistrict",
  "flood",
  "specialDistrict",
  "marketValue",
  "landValue",
  "improvementValue",
  "yearBuilt",
] as const;

export type ConstraintRail = (typeof CONSTRAINT_RAILS)[number];

/** Numeric rails order by value; the rest compare by equality only. */
export const NUMERIC_CONSTRAINT_RAILS = [
  "acreage",
  "marketValue",
  "landValue",
  "improvementValue",
  "yearBuilt",
] as const;

export type NumericConstraintRail = (typeof NUMERIC_CONSTRAINT_RAILS)[number];

export function isNumericConstraintRail(
  rail: ConstraintRail,
): rail is NumericConstraintRail {
  return (NUMERIC_CONSTRAINT_RAILS as readonly string[]).includes(rail);
}

export type ConstraintCell = {
  state: SmartSiteRailState;
  /** Ordered value for a numeric rail; null unless state is `present`. */
  number: number | null;
  /** Categorical value for a string rail; null unless state is `present`. */
  text: string | null;
  /** Boolean facet a rail may carry alongside its value (flood's SFHA flag). */
  flag: boolean | null;
  /**
   * Why this cell is what it is, in one machine token. An absence with no
   * basis is a guess wearing a determination's clothes.
   */
  basis: string;
};

export type ConstraintProjectionRow = {
  countyFips: string;
  propId: string;
  parcelNodeId: string;
  bakeSnapshotAt: string | null;
  cells: Record<ConstraintRail, ConstraintCell>;
};

/** Every input this derivation reads. Nothing else is consulted. */
export type ConstraintProjectionInput = {
  parcelNodeId: string;
  countyFips: string;
  propId: string;
  /** `place_layer_snapshots.payload_json` for `node-facets:tier1`. */
  tier1: unknown;
  /** `place_layer_snapshots.snapshot_at` for the tier1 row. */
  bakeSnapshotAt?: string | null;
  /**
   * `landing_parcel_jurisdiction.disposition` for this exact
   * `(county_fips, prop_id)`, or null when NO ROW EXISTS. Null is not
   * `unincorporated`; it is "never dispositioned", which is a different
   * state and the reason this argument is nullable rather than defaulted.
   */
  jurisdictionDisposition?: "in-city" | "unincorporated" | "unresolved" | null;
  /**
   * The flood-hazard-fact atom read for this parcel, already interpreted by
   * `floodHazardFactRead`. Passing the interpreted read rather than the raw
   * atom is deliberate: the serve path's interpretation is the only one, and
   * a second copy of it here would be two implementations of one rule.
   */
  flood?:
    | {
        state: "present";
        inSpecialFloodHazardArea: boolean;
        floodZone: string | null;
      }
    | { state: "absent"; absence: { kind: string; reason: string } | null }
    | { state: "refused"; code: string }
    | null;
  /**
   * The special-district-fact read: the district id when inside one, the
   * absence suffix (`none` / `outside` / the exact `:sd` form) when a writer
   * positively determined the parcel is in none, null when no atom exists.
   */
  specialDistrict?:
    | { state: "present"; districtId: string; districtType: string | null }
    | { state: "absent"; suffix: string }
    | { state: "refused"; code: string }
    | null;
};

function unread(basis: string): ConstraintCell {
  return { state: "unread", number: null, text: null, flag: null, basis };
}

function unknown(basis: string): ConstraintCell {
  return { state: "unknown", number: null, text: null, flag: null, basis };
}

function refused(basis: string): ConstraintCell {
  return { state: "refused", number: null, text: null, flag: null, basis };
}

function absentVerified(basis: string): ConstraintCell {
  return {
    state: "absent-verified",
    number: null,
    text: null,
    flag: null,
    basis,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A numeric bake field. `null` in the bake is NOT a measured zero and NOT a
 * verified absence: the tier-1 bake writes null both for "the CAD roll was
 * never joined onto this parcel" and for "the CAD row carried no value", and
 * it carries nothing that separates them. So this returns `unknown`, never
 * `absent-verified`. Zero is a real value and stays one.
 */
function numericCell(raw: unknown, sourceBasis: string): ConstraintCell {
  const n = finiteNumber(raw);
  if (n === null) return unknown(sourceBasis);
  return {
    state: "present",
    number: n,
    text: null,
    flag: null,
    basis: "bake-value",
  };
}

/**
 * Acreage is computed by the bake from parcel geometry
 * (`method: shoelace-wgs84`), not read off the roll. A missing or
 * non-positive value means the geometry did not yield one, which is
 * `unknown`: nobody determined the parcel has no area.
 */
function acreageCell(tier1Record: Record<string, unknown>): ConstraintCell {
  const baseFacts = asRecord(tier1Record.baseFacts) ?? {};
  const acreage = asRecord(baseFacts.acreage);
  const value = finiteNumber(acreage?.value);
  if (value === null || value <= 0) {
    return unknown("bake-acreage-absent");
  }
  return {
    state: "present",
    number: value,
    text: null,
    flag: null,
    basis: nonEmptyString(acreage?.method) ?? "bake-value",
  };
}

/**
 * ZONING IS THE ONE BAKE RAIL WITH A REAL VERIFIED ABSENCE, and it needs two
 * independently derived inputs to earn it: the bake payload says there is no
 * district, and `landing_parcel_jurisdiction` says the parcel is outside every
 * city. Unincorporated Texas land carries no municipal zoning, so that pair is
 * a positive determination rather than a gap. Either input alone is not: a
 * missing district with no jurisdiction row is a stamp gap (zoning coverage is
 * wired-city, not data), and an `in-city` parcel with no district means the
 * city's layer was never stamped, which is `unknown`.
 */
function zoningCell(
  tier1Record: Record<string, unknown>,
  jurisdiction: ConstraintProjectionInput["jurisdictionDisposition"],
): ConstraintCell {
  const zoning = tier1Record.zoning;
  if (zoningDisposition(zoning) === "present") {
    const record = asRecord(zoning);
    const district =
      nonEmptyString(zoning) ??
      nonEmptyString(record?.district) ??
      nonEmptyString(record?.zone) ??
      nonEmptyString(record?.code) ??
      nonEmptyString(record?.zoningCode);
    return {
      state: "present",
      number: null,
      text: district,
      flag: null,
      basis: "bake-zoning-district",
    };
  }
  if (jurisdiction === "unincorporated") {
    return absentVerified("unincorporated-no-municipal-zoning");
  }
  if (jurisdiction === "in-city") {
    return unknown("in-city-no-zoning-stamp");
  }
  return unknown("no-jurisdiction-disposition");
}

function landUseCell(tier1Record: Record<string, unknown>): ConstraintCell {
  const baseFacts = asRecord(tier1Record.baseFacts) ?? {};
  const landUse = baseFacts.landUse;
  if (landUseDisposition(landUse) === "present") {
    const record = asRecord(landUse);
    const code =
      nonEmptyString(landUse) ??
      nonEmptyString(record?.code) ??
      nonEmptyString(record?.landUseCode);
    return {
      state: "present",
      number: null,
      text: code,
      flag: null,
      basis: "bake-land-use-code",
    };
  }
  const provenance = asRecord(tier1Record.provenance);
  if (provenance?.landUseGateBlocked === true) {
    // The bake looked and DECLINED. A producer refusal about this parcel is
    // not the same state as never having looked.
    return refused("bake-land-use-gate-blocked");
  }
  return unknown("bake-land-use-absent");
}

function cityLimitsCell(
  jurisdiction: ConstraintProjectionInput["jurisdictionDisposition"],
): ConstraintCell {
  if (jurisdiction === "in-city" || jurisdiction === "unincorporated") {
    return {
      state: "present",
      number: null,
      text: jurisdiction,
      flag: null,
      basis: "landing-parcel-jurisdiction",
    };
  }
  if (jurisdiction === "unresolved") {
    // The jurisdiction run looked at this parcel and could not place it.
    return refused("landing-parcel-jurisdiction-unresolved");
  }
  return unknown("no-landing-parcel-jurisdiction-row");
}

function floodCell(flood: ConstraintProjectionInput["flood"]): ConstraintCell {
  if (!flood) return unknown("no-flood-hazard-fact-atom");
  if (flood.state === "present") {
    return {
      state: "present",
      number: null,
      text: flood.floodZone,
      flag: flood.inSpecialFloodHazardArea,
      basis: "flood-hazard-fact-atom",
    };
  }
  if (flood.state === "absent") {
    // A typed absence from the flood writer: the parcel was evaluated against
    // NFHL and intersects no mapped zone. That is a mapped negative, and it is
    // the state that makes "outside the floodplain" answerable for parcels
    // FEMA never drew a polygon over.
    return absentVerified(
      flood.absence?.kind
        ? `flood-hazard-fact-typed-absence:${flood.absence.kind}`
        : "flood-hazard-fact-typed-absence",
    );
  }
  // atom-miss is NOT an absence. Nobody evaluated this parcel.
  return flood.code === "atom-miss"
    ? unknown("flood-hazard-fact-atom-miss")
    : refused(`flood-hazard-fact-${flood.code}`);
}

function specialDistrictCell(
  sd: ConstraintProjectionInput["specialDistrict"],
): ConstraintCell {
  if (!sd) return unknown("no-special-district-fact-atom");
  if (sd.state === "present") {
    return {
      state: "present",
      number: null,
      text: sd.districtId,
      flag: null,
      basis: sd.districtType
        ? `special-district-fact-atom:${sd.districtType}`
        : "special-district-fact-atom",
    };
  }
  if (sd.state === "absent") {
    return absentVerified(`special-district-fact-absence:${sd.suffix || "sd"}`);
  }
  return refused(`special-district-fact-${sd.code}`);
}

/**
 * The whole derivation. Every rail in `CONSTRAINT_RAILS` gets a cell; a rail
 * is never omitted, because an omitted key and an unmeasured cell must not
 * look the same to a caller.
 */
export function projectConstraintCells(
  input: ConstraintProjectionInput,
): ConstraintProjectionRow {
  const tier1Record = asRecord(input.tier1);
  if (!tier1Record) {
    const allUnread = Object.fromEntries(
      CONSTRAINT_RAILS.map((rail) => [rail, unread("no-tier1-bake-row")]),
    ) as Record<ConstraintRail, ConstraintCell>;
    return {
      countyFips: input.countyFips,
      propId: input.propId,
      parcelNodeId: input.parcelNodeId,
      bakeSnapshotAt: input.bakeSnapshotAt ?? null,
      cells: allUnread,
    };
  }
  const baseFacts = asRecord(tier1Record.baseFacts) ?? {};
  const cadRoll = asRecord(baseFacts.cadRoll) ?? {};
  const cells: Record<ConstraintRail, ConstraintCell> = {
    acreage: acreageCell(tier1Record),
    landUse: landUseCell(tier1Record),
    cityLimits: cityLimitsCell(input.jurisdictionDisposition ?? null),
    // No extraterritorial-jurisdiction source exists in the deployment store.
    // Declared ahead, unread everywhere, and every filter over it refuses.
    etj: unread("no-etj-source-in-store"),
    zoningDistrict: zoningCell(tier1Record, input.jurisdictionDisposition ?? null),
    flood: floodCell(input.flood ?? null),
    specialDistrict: specialDistrictCell(input.specialDistrict ?? null),
    marketValue: numericCell(cadRoll.marketValue, "bake-cad-roll-absent"),
    landValue: numericCell(cadRoll.landValue, "bake-cad-roll-absent"),
    improvementValue: numericCell(cadRoll.improvementValue, "bake-cad-roll-absent"),
    yearBuilt: numericCell(baseFacts.yearBuilt, "bake-year-built-absent"),
  };
  return {
    countyFips: input.countyFips,
    propId: input.propId,
    parcelNodeId: input.parcelNodeId,
    bakeSnapshotAt: input.bakeSnapshotAt ?? null,
    cells,
  };
}

/**
 * The situs sentinel, exported so any instrument measuring situs shares one
 * predicate with the serve path rather than re-typing the character class. A
 * `", ,"` situs is not a situs.
 */
export function situsIsReal(value: unknown): boolean {
  return !isPunctuationOnlySitus(value);
}

/** A cell can be filtered on only when somebody determined something. */
export function cellIsEvaluable(cell: ConstraintCell): boolean {
  return cell.state === "present" || cell.state === "absent-verified";
}

export function isConstraintRailState(
  value: string,
): value is SmartSiteRailState {
  return (CONSTRAINT_RAIL_STATES as readonly string[]).includes(value);
}
