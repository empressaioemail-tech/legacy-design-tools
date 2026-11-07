/**
 * overlayDistricts fact type (F-01, serve/prod cutover for ACQUIRE-GIS wave
 * 1 + PARCEL wave 2, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts / ownerFactRead.ts,
 * this module is NOT a legacy atom reader -- there is no pre-existing
 * overlayDistricts serve path anywhere in this repo (verified: no
 * `overlayDistrict` reference exists in `artifacts/api-server/src` before
 * this card). This file carries only the shared type and the "not cut over
 * yet" refusal a rail with no legacy source needs.
 *
 * PLURAL, NOT A PICKED LEAD (contrast wells/specialDistricts): the writer
 * (hauska-factory's parcel-overlay-districts.mjs) stores one companion row
 * per matched overlay polygon, and a parcel can carry several distinct
 * overlays at once (a Character District, a historic district, etc. are not
 * mutually exclusive the way one lead well or one lead MUD district is).
 * `present.districts` is an array for that reason -- picking a single
 * "lead" here would silently drop real, independent facts.
 *
 * `attributes` is a generic bag, not a typed shape: the source
 * (tx_city_overlay.payload) is documented by the writer's own module
 * comment as "whatever tx_city_overlay.payload carried" -- heterogeneous by
 * design across different overlay kinds (a Character District payload looks
 * nothing like, say, a historic-district payload). Inventing a rigid schema
 * here would either drop real fields or silently coerce different overlay
 * kinds into one shape neither actually has.
 */

export const OVERLAY_DISTRICTS_FACT_SOURCE = "overlay-districts-fact" as const;
export const OVERLAY_DISTRICTS_RAIL_KEY = "overlayDistricts" as const;

export type OverlayDistrictEntry = {
  city: string;
  attributes: Record<string, unknown>;
};

export type OverlayDistrictsFactPresent = {
  state: "present";
  source: typeof OVERLAY_DISTRICTS_FACT_SOURCE;
  entityId: string;
  districts: OverlayDistrictEntry[];
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type OverlayDistrictsFactAbsent = {
  state: "absent";
  source: typeof OVERLAY_DISTRICTS_FACT_SOURCE;
  entityId: string;
  /** cityName is null only if the basis object itself carried none — never fabricated. */
  cityName: string | null;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type OverlayDistrictsFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type OverlayDistrictsFactRefusal = {
  state: "refused";
  code: OverlayDistrictsFactRefusalCode;
  source: typeof OVERLAY_DISTRICTS_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type OverlayDistrictsFactRead =
  | OverlayDistrictsFactPresent
  | OverlayDistrictsFactAbsent
  | OverlayDistrictsFactRefusal;

/**
 * NOTE ON `unaccounted` AT THIS RAIL'S OWN SCALE: the writer never writes a
 * cell for a parcel outside all 12 confirmed cities (the vast majority of
 * every program county's parcels) -- that cell stays 'unaccounted' by
 * design, indistinguishable at the cell level from "never examined". This
 * means a per-county unaccountedCount-based gate verdict may never read
 * 'pass' for this rail under the existing gate model, unless whoever owns
 * gate-rail-cli.mjs has (or adds) a way to exclude "outside this rail's own
 * reach" cells from that count -- a question for that seat, not resolved by
 * this cutover. Every `unaccounted` cell still refuses honestly either way
 * (see overlayDistrictsFactFromParcelRecord.ts); this module fabricates
 * nothing regardless of how that question is eventually answered.
 */
export function notCutOverOverlayDistrictsFact(
  parcelNodeId: string,
): OverlayDistrictsFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: OVERLAY_DISTRICTS_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "overlayDistricts has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
