/**
 * schoolDistrict fact type (F-01, serve/prod cutover for ACQUIRE-GIS wave 1
 * + PARCEL wave 2, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts / ownerFactRead.ts,
 * this module is NOT a legacy atom reader -- there is no pre-existing
 * schoolDistrict serve path anywhere in this repo. This file carries only
 * the shared type and the "not cut over yet" refusal a rail with no legacy
 * source needs.
 *
 * `districtCode`/`geoid` live on the CELL ITSELF, not a companion row
 * (parcel-school-district.mjs's schoolDistrictCellState) -- read via
 * loadParcelRecordCell's `raw` field (parcelRecordCellRead.ts), added by
 * this same card for exactly this case.
 *
 * A KNOWN, NAMED ANOMALY CLASS: the writer never writes absent-verified for
 * this rail (every TX parcel is expected to sit in exactly one ISD); a
 * zero-hit or multi-hit centroid is left as `unaccounted` and collected
 * into the writer's own `anomalies` report instead. This adapter therefore
 * surfaces those cases as the ordinary `parcel-record-unaccounted` refusal,
 * same as any other unexamined cell -- it does not (and structurally
 * cannot, from the serve side alone) distinguish "never examined" from
 * "examined, found 0 or 2+ districts" without the writer's own anomalies
 * report, which this reader has no access to. 13 such anomalies existed
 * program-wide as of the acquire close (_inbox/2026-09-03_parcel-acquire-gis_close.json)
 * out of 981,405 parcels, never enumerated by place_key -- so a served
 * `not-cut-over`/`unaccounted` refusal on one of those 13 is expected, not
 * a defect in this cutover.
 */

export const SCHOOL_DISTRICT_FACT_SOURCE = "school-district-fact" as const;
export const SCHOOL_DISTRICT_RAIL_KEY = "schoolDistrict" as const;

export type SchoolDistrictFactPresent = {
  state: "present";
  source: typeof SCHOOL_DISTRICT_FACT_SOURCE;
  entityId: string;
  districtName: string;
  /** The hyphenated CCC-DDD Texas County-District code, e.g. "161-909". Never the concatenated form. */
  districtCode: string | null;
  geoid: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type SchoolDistrictFactAbsent = {
  state: "absent";
  source: typeof SCHOOL_DISTRICT_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type SchoolDistrictFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type SchoolDistrictFactRefusal = {
  state: "refused";
  code: SchoolDistrictFactRefusalCode;
  source: typeof SCHOOL_DISTRICT_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type SchoolDistrictFactRead =
  | SchoolDistrictFactPresent
  | SchoolDistrictFactAbsent
  | SchoolDistrictFactRefusal;

export function notCutOverSchoolDistrictFact(
  parcelNodeId: string,
): SchoolDistrictFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: SCHOOL_DISTRICT_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "schoolDistrict has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
