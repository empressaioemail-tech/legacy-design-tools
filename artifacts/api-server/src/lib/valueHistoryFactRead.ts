/**
 * valueHistory fact type (F-01, PARCEL-B-SLATE1 template, serve/prod
 * cutover, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * UNLIKE wellFactRead.ts / specialDistrictFactRead.ts, this module is NOT a
 * legacy atom reader -- no valueHistory serve path exists anywhere in this
 * repo prior to this card (confirmed by a repo-wide search before writing
 * this file). This file carries only the shared type and the "not cut over
 * yet" refusal a rail with no legacy source needs, matching
 * agValuationFactRead.ts's own pattern.
 *
 * COMPANION, NOT SCALAR (contrast marketValue/assessedValue/landValue/
 * improvementValue, which stay current-year-only per the rails-v2
 * decision): valueHistory carries every distinct prior tax_year cad_property
 * already holds for a parcel. Ingested by hauska-factory's
 * parcel-value-history.mjs (PARCEL-VALUE-HISTORY, closed 2026-09-02, all six
 * program counties, --apply, every county's companion-row count exactly
 * matching its landing denominator). A Williamson-only crosswalk collision
 * between two situs-sharing R-accounts was found and fixed
 * (PARCEL-VH-COLLISION, closed 2026-09-03, doc_repo
 * `_inbox/2026-09-03_parcel-vh-collision_close.json`); the other five
 * counties never touch the crosswalk path and were never exposed.
 *
 * Dollar fields inside each entry arrive as STRINGS on the wire, off
 * cad_property's bigint columns read through a raw (non-Drizzle) pg client
 * -- the identical source columns and read pattern
 * cadRollFactFromParcelRecord.ts's own module doc already confirmed this
 * for live. This adapter reuses cadRollValue.ts's nonNegativeDollarOrNull
 * for the same coercion and the same 0-vs-absent, negative-vs-absent rules
 * every other CAD dollar rail in this program uses.
 */

export const VALUE_HISTORY_FACT_SOURCE = "value-history-fact" as const;
export const VALUE_HISTORY_RAIL_KEY = "valueHistory" as const;

export type ValueHistoryEntry = {
  taxYear: number;
  marketValue: number | null;
  assessedValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  /** True when this year's row was reached via Williamson's R1B situs crosswalk rather than a direct cad_property row for this prop_id. */
  viaCrosswalk: boolean;
};

export type ValueHistoryFactPresent = {
  state: "present";
  source: typeof VALUE_HISTORY_FACT_SOURCE;
  entityId: string;
  entries: ValueHistoryEntry[];
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type ValueHistoryFactAbsent = {
  state: "absent";
  source: typeof VALUE_HISTORY_FACT_SOURCE;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type ValueHistoryFactRefusalCode =
  | "invalid-parcel-node-id"
  | "not-cut-over"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type ValueHistoryFactRefusal = {
  state: "refused";
  code: ValueHistoryFactRefusalCode;
  source: typeof VALUE_HISTORY_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type ValueHistoryFactRead =
  | ValueHistoryFactPresent
  | ValueHistoryFactAbsent
  | ValueHistoryFactRefusal;

export function notCutOverValueHistoryFact(
  parcelNodeId: string,
): ValueHistoryFactRefusal {
  return {
    state: "refused",
    code: "not-cut-over",
    source: VALUE_HISTORY_FACT_SOURCE,
    entityId: parcelNodeId,
    reason:
      "valueHistory has no legacy serve path -- it is served only from parcel_record, and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel.",
  };
}
