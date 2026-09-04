/**
 * parcel_record -> MaxImperviousCoverPctFactRead adapter (F-01, serve/prod
 * cutover, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * A scalar cell with NO companion rows -- its extra fields
 * (`watershedType`, `inRechargeZone`, `crosswalkCitation`) live on the
 * cell_state itself (parcel-max-impervious-cover.mjs's
 * maxImperviousCoverCellState), read via loadParcelRecordCell's `raw`
 * field.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
  MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY,
  type MaxImperviousCoverPctFactRead,
} from "./maxImperviousCoverPctFactRead";

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

export async function maxImperviousCoverPctFactFromParcelRecord(
  parcelNodeId: string,
): Promise<MaxImperviousCoverPctFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY);

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
      source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    // The writer never writes absent-verified for this rail (see module
    // doc), but the shared reader's type admits it -- handled honestly
    // rather than assumed unreachable.
    return {
      state: "absent",
      source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present"
  const percent = asNullableNumber(cell.value);
  if (percent === null) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY} is kind=value but its value is not a readable percent. Refusing rather than inventing one.`,
    };
  }

  return {
    state: "present",
    source: MAX_IMPERVIOUS_COVER_PCT_FACT_SOURCE,
    entityId: placeKey,
    percent,
    watershedType: asNullableString(cell.raw.watershedType),
    inRechargeZone: cell.raw.inRechargeZone === true,
    crosswalkCitation: asNullableString(cell.raw.crosswalkCitation),
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
