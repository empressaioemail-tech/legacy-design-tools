/**
 * P-445: envelope-derived facts (max height, lot coverage, max footprint)
 * must not say ENVELOPE_ROUTER_NOT_A_DISTRICT when the zoning rail already
 * resolved a present district. One reason, consistent with zoning.
 *
 * The factory cell may still carry the old finding until republish. This
 * module is the serve-path overlay: it rewrites the reason, or promotes a
 * table-specified scalar, from the same district+table decision zoning used.
 */

import {
  getSetbackTableForZoning,
  isSetbackRefusalError,
  type SetbackDistrict,
  type SetbackRefusalCode,
} from "@workspace/adapters";

import { mapDistrict } from "./buildableEnvelope/districtMapping";
import type { MaxFootprintSqFtFactRead } from "./maxFootprintSqFtFactRead";
import type { MaxHeightFtFactRead } from "./maxHeightFtFactRead";
import type { MaxLotCoveragePctFactRead } from "./maxLotCoveragePctFactRead";

export const ENVELOPE_ROUTER_NOT_A_DISTRICT = "ENVELOPE_ROUTER_NOT_A_DISTRICT";
export const ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED =
  "ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED";
export const ENVELOPE_ROUTER_CODE_SETS_NONE = "ENVELOPE_ROUTER_CODE_SETS_NONE";
/**
 * W3 PR #805 review (2026-10-09): `getSetbackTableForZoning` now throws a named refusal (gate 2's
 * six edition-currency codes, or gate 3's SETBACK_TABLE_ABSENT) instead of silently returning null
 * for a jurisdiction/district whose source is unverified, superseded, ambiguous, conditional, has no
 * dimensional standards, or whose register clears it but has no vendored table. `lookUpEnvelopeTableRow`
 * below catches exactly that family (by `code`, via `isSetbackRefusalError` -- never by message text)
 * and reports it here rather than letting it crash this "decline, never invent" read. The reason
 * string carries the upstream code as a suffix (`ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED:<code>`) so a
 * caller can say WHY -- e.g. "this city's ordinance edition is not verified" for
 * SETBACK_EDITION_UNVERIFIED -- instead of the generic, less informative ENVELOPE_ROUTER_CODE_SETS_NONE.
 */
export const ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED =
  "ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED";

export type EnvelopeTableRowLookup = {
  tableHasDistrictRow: boolean;
  district: SetbackDistrict | null;
  /**
   * Set when `getSetbackTableForZoning` threw a named setback refusal rather than returning a table.
   * `null`/absent for the ordinary "no row for this code" case (which keeps using
   * ENVELOPE_ROUTER_CODE_SETS_NONE below) and for a successful lookup.
   */
  sourceRefusal?: { code: SetbackRefusalCode; detail: string } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function fieldNotSpecified(
  district: SetbackDistrict,
  field: string,
): boolean {
  const prov = asRecord(district.provenance?.[field]);
  return prov?.not_specified === true;
}

export function lookUpEnvelopeTableRow(
  jurisdictionKey: string | null | undefined,
  districtCode: string | null | undefined,
): EnvelopeTableRowLookup {
  const code = (districtCode ?? "").trim();
  if (!code) return { tableHasDistrictRow: false, district: null };
  const key = (jurisdictionKey ?? "").trim() || "bastrop-tx";
  let table;
  try {
    table = getSetbackTableForZoning(key, code);
  } catch (err) {
    // Decline, never invent: a named setback refusal (gate 2/3) is reported, not thrown, so this
    // "is there a row" read degrades the same way an ordinary missing row already does. Anything
    // else is a real bug and must still surface.
    if (!isSetbackRefusalError(err)) throw err;
    return {
      tableHasDistrictRow: false,
      district: null,
      sourceRefusal: { code: err.code, detail: err.message },
    };
  }
  if (!table) return { tableHasDistrictRow: false, district: null };
  const mapped = mapDistrict(table, code);
  return {
    tableHasDistrictRow: mapped != null,
    district: mapped?.district ?? null,
  };
}

function rewriteAbsenceReason<
  T extends { state: "absent"; absence: { kind: string; reason: string } | null },
>(fact: T, reason: string): T {
  return {
    ...fact,
    absence: { kind: fact.absence?.kind ?? "absent-verified", reason },
  };
}

/**
 * The reason to use when `row` carries no usable district row at all. A named setback refusal
 * (`row.sourceRefusal`) is MORE specific than the generic "this code's chart sets nothing" --
 * carries the upstream code through so a caller can say WHY -- and wins when present.
 */
function missingRowReason(row: EnvelopeTableRowLookup): string {
  if (row.sourceRefusal) {
    return `${ENVELOPE_ROUTER_SETBACK_SOURCE_REFUSED}:${row.sourceRefusal.code}`;
  }
  return ENVELOPE_ROUTER_CODE_SETS_NONE;
}

export function reconcileMaxHeightFtFact(
  fact: MaxHeightFtFactRead,
  zoningDistrictPresent: boolean,
  row: EnvelopeTableRowLookup,
): MaxHeightFtFactRead {
  if (fact.state !== "absent") return fact;
  if (!zoningDistrictPresent) return fact;
  if (fact.absence?.reason !== ENVELOPE_ROUTER_NOT_A_DISTRICT) return fact;
  if (!row.tableHasDistrictRow || !row.district) {
    return rewriteAbsenceReason(fact, missingRowReason(row));
  }
  if (fieldNotSpecified(row.district, "max_height_ft")) {
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
  }
  return {
    state: "present",
    source: fact.source,
    entityId: fact.entityId,
    feet: row.district.max_height_ft,
    citationUrl: row.district.citation_url,
    districtCode:
      row.district.district_name.trim().split(/\s+/)[0] ?? null,
    districtName: row.district.district_name,
    jurisdictionKey: null,
    sourceAdapter: "parcel_record",
    sourceVintage: fact.sourceVintage,
    evaluatedAt: fact.sourceVintage,
  };
}

export function reconcileMaxLotCoveragePctFact(
  fact: MaxLotCoveragePctFactRead,
  zoningDistrictPresent: boolean,
  row: EnvelopeTableRowLookup,
): MaxLotCoveragePctFactRead {
  if (fact.state !== "absent") return fact;
  if (!zoningDistrictPresent) return fact;
  if (fact.absence?.reason !== ENVELOPE_ROUTER_NOT_A_DISTRICT) return fact;
  if (!row.tableHasDistrictRow || !row.district) {
    return rewriteAbsenceReason(fact, missingRowReason(row));
  }
  if (fieldNotSpecified(row.district, "max_lot_coverage_pct")) {
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
  }
  return {
    state: "present",
    source: fact.source,
    entityId: fact.entityId,
    percent: row.district.max_lot_coverage_pct,
    citationUrl: row.district.citation_url,
    districtCode:
      row.district.district_name.trim().split(/\s+/)[0] ?? null,
    districtName: row.district.district_name,
    jurisdictionKey: null,
    sourceAdapter: "parcel_record",
    sourceVintage: fact.sourceVintage,
    evaluatedAt: fact.sourceVintage,
  };
}

export function reconcileMaxFootprintSqFtFact(
  fact: MaxFootprintSqFtFactRead,
  zoningDistrictPresent: boolean,
  row: EnvelopeTableRowLookup,
): MaxFootprintSqFtFactRead {
  if (fact.state !== "absent") return fact;
  if (!zoningDistrictPresent) return fact;
  if (fact.absence?.reason !== ENVELOPE_ROUTER_NOT_A_DISTRICT) return fact;
  if (!row.tableHasDistrictRow || !row.district) {
    return rewriteAbsenceReason(fact, missingRowReason(row));
  }
  if (fieldNotSpecified(row.district, "max_lot_coverage_pct")) {
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
  }
  return fact;
}
