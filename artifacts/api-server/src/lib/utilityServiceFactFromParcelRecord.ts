/**
 * parcel_record -> UtilityServiceFactRead adapter (F-01, serve/prod cutover,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Companion rows are FIXED SLOTS (parcel-utility-service.mjs's own
 * WATER_ROW_INDEX=0 / SEWER_ROW_INDEX=1), not sequential-by-discovery like
 * wells/specialDistricts -- a sewer-only parcel's row still lives at
 * rowIndex 1, never compacted to 0. This adapter reads by rowIndex
 * explicitly rather than by array position for that reason.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code, matching the house
 * convention in wellFactFromParcelRecord.ts / specialDistrictFactFromParcelRecord.ts.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  UTILITY_SERVICE_FACT_SOURCE,
  UTILITY_SERVICE_RAIL_KEY,
  type UtilityServiceEntry,
  type UtilityServiceFactRead,
} from "./utilityServiceFactRead";

const WATER_ROW_INDEX = 0;
const SEWER_ROW_INDEX = 1;

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

function entryFromCompanionRow(row: ParcelRecordCompanionRow | undefined): UtilityServiceEntry | null {
  if (!row) return null;
  const rec = asRecord(row.payload);
  if (!rec) return null;
  return {
    ccnNo: asNullableString(rec.ccnNo),
    utility: asNullableString(rec.utility),
    status: asNullableString(rec.status),
    ccnType: asNullableString(rec.ccnType),
  };
}

export async function utilityServiceFactFromParcelRecord(
  parcelNodeId: string,
): Promise<UtilityServiceFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: UTILITY_SERVICE_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, UTILITY_SERVICE_RAIL_KEY);

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
      source: UTILITY_SERVICE_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: UTILITY_SERVICE_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present"
  const byIndex = new Map(cell.companionRows.map((r) => [r.rowIndex, r] as const));
  const water = entryFromCompanionRow(byIndex.get(WATER_ROW_INDEX));
  const sewer = entryFromCompanionRow(byIndex.get(SEWER_ROW_INDEX));

  if (water === null && sewer === null) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: UTILITY_SERVICE_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${UTILITY_SERVICE_RAIL_KEY} is kind=value but neither its water (rowIndex 0) nor sewer (rowIndex 1) companion row was readable. Refusing rather than inventing service.`,
    };
  }

  return {
    state: "present",
    source: UTILITY_SERVICE_FACT_SOURCE,
    entityId: placeKey,
    water,
    sewer,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
