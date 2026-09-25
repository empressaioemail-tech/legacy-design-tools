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
  type SetbackDistrict,
} from "@workspace/adapters";

import { mapDistrict } from "./buildableEnvelope/districtMapping";
import type { MaxFootprintSqFtFactRead } from "./maxFootprintSqFtFactRead";
import type { MaxHeightFtFactRead } from "./maxHeightFtFactRead";
import type { MaxLotCoveragePctFactRead } from "./maxLotCoveragePctFactRead";

export const ENVELOPE_ROUTER_NOT_A_DISTRICT = "ENVELOPE_ROUTER_NOT_A_DISTRICT";
export const ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED =
  "ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED";
export const ENVELOPE_ROUTER_CODE_SETS_NONE = "ENVELOPE_ROUTER_CODE_SETS_NONE";

export type EnvelopeTableRowLookup = {
  tableHasDistrictRow: boolean;
  district: SetbackDistrict | null;
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
  const table = getSetbackTableForZoning(key, code);
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

export function reconcileMaxHeightFtFact(
  fact: MaxHeightFtFactRead,
  zoningDistrictPresent: boolean,
  row: EnvelopeTableRowLookup,
): MaxHeightFtFactRead {
  if (fact.state !== "absent") return fact;
  if (!zoningDistrictPresent) return fact;
  if (fact.absence?.reason !== ENVELOPE_ROUTER_NOT_A_DISTRICT) return fact;
  if (!row.tableHasDistrictRow || !row.district) {
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_CODE_SETS_NONE);
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
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_CODE_SETS_NONE);
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
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_CODE_SETS_NONE);
  }
  if (fieldNotSpecified(row.district, "max_lot_coverage_pct")) {
    return rewriteAbsenceReason(fact, ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED);
  }
  return fact;
}
