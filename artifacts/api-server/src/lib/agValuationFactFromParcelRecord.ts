/**
 * parcel_record -> AgValuationFactRead adapter (F-01, serve/prod cutover,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Every companion row is a hit, sequential by discovery (rowIndex 0..N-1),
 * one per WCAD/TCAD land record (parcel-ag-valuation.mjs's own
 * writeAgValuationResults). Payload shape is agValuationCompanionPayload's
 * exact fields, shared verbatim across Williamson (WCAD) and Travis (TCAD)
 * by the writer itself.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  AG_VALUATION_FACT_SOURCE,
  AG_VALUATION_RAIL_KEY,
  type AgValuationEntry,
  type AgValuationFactRead,
} from "./agValuationFactRead";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Some CAD source columns (rawAgFlag, agYear) are not coerced by the writer -- preserve whichever primitive type actually came through, never invent one. */
function asNullableStringOrNumber(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
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

function entryFromCompanionRow(row: ParcelRecordCompanionRow): AgValuationEntry | null {
  const rec = asRecord(row.payload);
  if (!rec) return null;
  return {
    statecode: asNullableString(rec.statecode),
    landType: asNullableString(rec.landType),
    description: asNullableString(rec.description),
    acres: asNullableNumber(rec.acres),
    value: asNullableNumber(rec.value),
    currValue: asNullableNumber(rec.currValue),
    agFlag: rec.agFlag === true,
    rawAgFlag: asNullableStringOrNumber(rec.rawAgFlag),
    sequence: asNullableNumber(rec.sequence),
    apprMethod: asNullableString(rec.apprMethod),
    agYear: asNullableStringOrNumber(rec.agYear),
    propertyNumber: asNullableString(rec.propertyNumber),
  };
}

export async function agValuationFactFromParcelRecord(
  parcelNodeId: string,
): Promise<AgValuationFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: AG_VALUATION_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, AG_VALUATION_RAIL_KEY);

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
      source: AG_VALUATION_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: AG_VALUATION_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present"
  const entries = cell.companionRows
    .map(entryFromCompanionRow)
    .filter((e): e is AgValuationEntry => e !== null);

  if (entries.length === 0) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: AG_VALUATION_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${AG_VALUATION_RAIL_KEY} is kind=value but its companion rows were empty or unreadable. Refusing rather than inventing a land record.`,
    };
  }

  return {
    state: "present",
    source: AG_VALUATION_FACT_SOURCE,
    entityId: placeKey,
    entries,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
