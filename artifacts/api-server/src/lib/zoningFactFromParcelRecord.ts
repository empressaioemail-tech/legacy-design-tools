/**
 * parcel_record -> ZoningFactRead adapter (F-01, PARCEL-B-SLATE3, OPS-16
 * A-096/A-097/A-098, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Reads THREE independent parcel_record rail keys that together compose one
 * zoning determination: zoningDistrict (the district code itself),
 * zoningJurisdictionKey, and zoningProvenance. hauska-factory's rail-keys.js
 * (UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS) writes all three identically for
 * an unincorporated parcel -- {kind:"not-applicable", reason:
 * UNINCORPORATED_ZONING_REASON} -- at row-creation time (instantiate.js), so
 * this adapter gates the WHOLE determination on zoningDistrict's own cell
 * state (the representative key; jurisdictionKey/provenance are metadata
 * ABOUT that same determination, not independent facts on their own -- a
 * jurisdictionKey or provenance with no district is not a usable
 * determination, matching zoningDisposition's own rule in r1BriefCompose.ts).
 * jurisdictionKey/provenance are still read from their OWN cells (never
 * inferred from the district's cell) so a genuinely partial write is
 * reported honestly rather than assumed.
 *
 * zoningProvenance's cell value is read through the shared reader's scalar
 * `value` field (string | number | boolean | null) -- unlike the Tier-1
 * bake's own richer `provenance: {sourceUrl, codeField, ...}` object
 * (zoningProvenance.ts, a same-named but DIFFERENT concept: GIS layer
 * provenance for citations, not this rail), parcel_record's zoningProvenance
 * rail is its own flat scalar rail. This adapter serves it as a plain
 * citation string. DISCLOSED, not hidden: a parcel_record-sourced zoning
 * determination therefore carries a less structured provenance than the
 * legacy GIS-stamp path when both are present -- not a defect in this
 * adapter, matching wellFactFromParcelRecord.ts's own disclosed-lossiness
 * convention.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader shared with every other rail adapter.
 * `unaccounted` is never rendered as an absence -- it becomes a distinct
 * refusal code, matching this repo's own house convention in every sibling
 * *FactFromParcelRecord.ts module.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";

export const ZONING_FACT_SOURCE = "zoning-fact-parcel-record" as const;
export const ZONING_DISTRICT_RAIL_KEY = "zoningDistrict" as const;
export const ZONING_JURISDICTION_KEY_RAIL_KEY = "zoningJurisdictionKey" as const;
export const ZONING_PROVENANCE_RAIL_KEY = "zoningProvenance" as const;
export const ZONING_RAIL_KEYS = [
  ZONING_DISTRICT_RAIL_KEY,
  ZONING_JURISDICTION_KEY_RAIL_KEY,
  ZONING_PROVENANCE_RAIL_KEY,
] as const;

export type ZoningFactPresent = {
  state: "present";
  source: typeof ZONING_FACT_SOURCE;
  entityId: string;
  district: string;
  jurisdictionKey: string | null;
  provenance: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type ZoningFactAbsent = {
  state: "absent";
  source: typeof ZONING_FACT_SOURCE;
  entityId: string;
  absence: { kind: "absent-verified" | "not-applicable"; reason: string };
  /** true only for a genuine "swept, found nothing" absent-verified; null for not-applicable -- matches every sibling adapter's own verifiedAbsence convention. */
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type ZoningFactRefusalCode =
  | "invalid-parcel-node-id"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type ZoningFactRefusal = {
  state: "refused";
  code: ZoningFactRefusalCode;
  source: typeof ZONING_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type ZoningFactRead = ZoningFactPresent | ZoningFactAbsent | ZoningFactRefusal;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reasonFromBasis(basis: string | Record<string, unknown> | null): string {
  if (typeof basis === "string") return basis;
  const rec = asRecord(basis);
  if (rec) {
    const finding = asNullableString(rec.finding) ?? asNullableString(rec.reason);
    if (finding) return finding;
    return JSON.stringify(rec);
  }
  return "parcel_record marked this cell absent with no basis recorded.";
}

function methodFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.method) : null;
}

const REFUSAL_CODE_MAP = {
  unaccounted: "parcel-record-unaccounted",
  "engine-refused": "parcel-record-engine-refused",
  "no-such-parcel-or-rail": "parcel-record-cell-miss",
  "malformed-cell": "parcel-record-malformed-cell",
  "store-not-configured": "parcel-record-store-not-configured",
} as const;

/**
 * Best-effort scalar string read of a sibling zoning rail cell (jurisdiction
 * key or provenance) -- honestly null on anything but a real present string
 * value. Never throws, never fabricates.
 */
async function scalarStringOrNull(
  countyFips: string,
  propId: string,
  railKey: string,
): Promise<string | null> {
  const cell = await loadParcelRecordCell(countyFips, propId, railKey);
  if (cell.state !== "present") return null;
  return typeof cell.value === "string" && cell.value.trim() ? cell.value : null;
}

export async function zoningFactFromParcelRecord(parcelNodeId: string): Promise<ZoningFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: ZONING_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, ZONING_DISTRICT_RAIL_KEY);

  if (cell.state === "refused") {
    return {
      state: "refused",
      code: REFUSAL_CODE_MAP[cell.code],
      source: ZONING_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: ZONING_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
  }

  // cell.state === "present"
  const district = typeof cell.value === "string" && cell.value.trim() ? cell.value : null;
  if (!district) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: ZONING_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${ZONING_DISTRICT_RAIL_KEY} is kind=value but its value is not a readable district. Refusing rather than inventing one.`,
    };
  }
  const [jurisdictionKey, provenance] = await Promise.all([
    scalarStringOrNull(parsed.countyFips, parsed.propId, ZONING_JURISDICTION_KEY_RAIL_KEY),
    scalarStringOrNull(parsed.countyFips, parsed.propId, ZONING_PROVENANCE_RAIL_KEY),
  ]);
  return {
    state: "present",
    source: ZONING_FACT_SOURCE,
    entityId: placeKey,
    district,
    jurisdictionKey,
    provenance,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
