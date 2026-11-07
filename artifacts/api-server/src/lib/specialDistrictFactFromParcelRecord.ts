/**
 * parcel_record -> SpecialDistrictFactRead adapter (F-01, PARCEL-B-SLATE1,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * parcel_record's `specialDistricts` rail is a spatial containment sweep
 * (R4's own mission spec, doc_repo:_catalog/dispatch_missions/
 * mission_parcel_r4_companions.md) that can populate MULTIPLE companion
 * rows per parcel (live-verified 2026-09-02, 48021:103414 rowCount=2). The
 * legacy atom's own SpecialDistrictFactPresent shape carries exactly ONE
 * district, and its own loadSpecialDistrictFactAtom already resolves
 * multiple atoms down to one preferred district via pickPreferredPresent
 * (prefer districtType=MUD, then integer prefix, then lexical entity_id
 * order) -- this adapter mirrors that SAME preference rule (prefer MUD,
 * then lexical districtId order) so the two sources pick the same "lead"
 * district for a parcel that (rarely) has more than one, preserving
 * behavioral parity rather than picking an arbitrary row.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  SPECIAL_DISTRICT_FACT_SOURCE,
  type SpecialDistrictFactPresent,
  type SpecialDistrictFactRead,
} from "./specialDistrictFactRead";

export const SPECIAL_DISTRICTS_RAIL_KEY = "specialDistricts" as const;
const MUD_DISTRICT_TYPE = "MUD";

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
    const finding = asNullableString(rec.finding);
    if (finding) return finding;
    return JSON.stringify(rec);
  }
  return "parcel_record marked this cell absent with no basis recorded.";
}

function methodFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.method) : null;
}

function vintageFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.vintage) : null;
}

type DistrictCandidate = {
  districtId: string;
  districtType: string | null;
  districtName: string | null;
};

function districtFromCompanionRow(row: ParcelRecordCompanionRow): DistrictCandidate | null {
  const rec = asRecord(row.payload);
  if (!rec) return null;
  const districtId = asNullableString(rec.districtId);
  if (!districtId) return null;
  return {
    districtId,
    districtType: asNullableString(rec.districtType),
    districtName: asNullableString(rec.districtName),
  };
}

/** Mirrors the legacy atom's pickPreferredPresent: prefer MUD, then lexical districtId order. */
function pickLeadDistrict(candidates: DistrictCandidate[]): DistrictCandidate {
  const mudHits = candidates.filter((c) => c.districtType === MUD_DISTRICT_TYPE);
  const pool = mudHits.length > 0 ? mudHits : candidates;
  return [...pool].sort((a, b) => a.districtId.localeCompare(b.districtId))[0];
}

export async function specialDistrictFactFromParcelRecord(
  parcelNodeId: string,
): Promise<SpecialDistrictFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried: [],
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const tried: readonly [string, string] = [placeKey, placeKey];
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, SPECIAL_DISTRICTS_RAIL_KEY);

  if (cell.state === "refused") {
    const codeMap = {
      unaccounted: "parcel-record-unaccounted",
      "engine-refused": "parcel-record-engine-refused",
      "no-such-parcel-or-rail": "parcel-record-cell-miss",
      "malformed-cell": "parcel-record-malformed-cell",
      "store-not-configured": "parcel-record-store-not-configured",
    } as const;
    return {
      state: "refused",
      code: codeMap[cell.code],
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      boundAs: placeKey,
      tried,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present"
  const candidates = cell.companionRows
    .map(districtFromCompanionRow)
    .filter((c): c is DistrictCandidate => c !== null);

  if (candidates.length === 0) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `parcel_record_cell ${placeKey}/${SPECIAL_DISTRICTS_RAIL_KEY} is kind=value but its companion rows were empty or unreadable. Refusing rather than inventing a district.`,
    };
  }

  const lead = pickLeadDistrict(candidates);
  const present: SpecialDistrictFactPresent = {
    state: "present",
    source: SPECIAL_DISTRICT_FACT_SOURCE,
    boundAs: placeKey,
    tried,
    entityId: placeKey,
    districtId: lead.districtId,
    districtType: lead.districtType,
    districtName: lead.districtName,
    evaluatedAt: cell.vintage || null,
  };
  return present;
}
