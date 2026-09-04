/**
 * parcel_record -> ValueHistoryFactRead adapter (F-01, PARCEL-B-SLATE1
 * template, serve/prod cutover,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Every companion row is one distinct tax_year (parcel-value-history.mjs's
 * own writeHistoryResults, hauska-factory), sequential by year ascending
 * (rowIndex 0..N-1). Payload shape is historyPayload's exact fields
 * (taxYear, marketValue, assessedValue, landValue, improvementValue,
 * viaCrosswalk), shared across all six counties by the writer itself;
 * Williamson's viaCrosswalk=true rows are the R1B situs crosswalk, fixed
 * for the sibling-collision case by PARCEL-VH-COLLISION (2026-09-03).
 *
 * Dollar fields arrive as STRINGS off cad_property's bigint columns (same
 * source, same raw-pg read pattern as cadRollFactFromParcelRecord.ts,
 * confirmed live there for the identical columns) -- reuses
 * nonNegativeDollarOrNull for the same coercion and 0-vs-absent,
 * negative-vs-absent rules every other CAD dollar rail in this program
 * uses.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code. The writer itself never
 * emits absent-verified for this rail (a parcel with no cad_property row
 * anywhere is a join miss, not a positive absence claim, per the writer's
 * own module doc) -- the absent branch below is handled anyway, matching
 * every sibling adapter's defensive posture toward a cell shape the shared
 * reader is generic over.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import { nonNegativeDollarOrNull } from "./cadRollValue";
import {
  VALUE_HISTORY_FACT_SOURCE,
  VALUE_HISTORY_RAIL_KEY,
  type ValueHistoryEntry,
  type ValueHistoryFactRead,
} from "./valueHistoryFactRead";

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

/** taxYear is written as a JS number by the writer (`Number(row.tax_year)`), but read defensively in case a future writer version emits a numeric string, matching this program's own house convention of coercing rather than trusting a wire shape unverified. */
function entryFromCompanionRow(row: ParcelRecordCompanionRow): ValueHistoryEntry | null {
  const rec = asRecord(row.payload);
  if (!rec) return null;
  const taxYear =
    typeof rec.taxYear === "number" && Number.isFinite(rec.taxYear)
      ? rec.taxYear
      : typeof rec.taxYear === "string" && rec.taxYear.trim() !== ""
        ? Number(rec.taxYear)
        : NaN;
  if (!Number.isFinite(taxYear)) return null;
  return {
    taxYear,
    marketValue: nonNegativeDollarOrNull(rec.marketValue),
    assessedValue: nonNegativeDollarOrNull(rec.assessedValue),
    landValue: nonNegativeDollarOrNull(rec.landValue),
    improvementValue: nonNegativeDollarOrNull(rec.improvementValue),
    viaCrosswalk: rec.viaCrosswalk === true,
  };
}

export async function valueHistoryFactFromParcelRecord(
  parcelNodeId: string,
): Promise<ValueHistoryFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: VALUE_HISTORY_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, VALUE_HISTORY_RAIL_KEY);

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
      source: VALUE_HISTORY_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: VALUE_HISTORY_FACT_SOURCE,
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
    .filter((e): e is ValueHistoryEntry => e !== null);

  if (entries.length === 0) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: VALUE_HISTORY_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${VALUE_HISTORY_RAIL_KEY} is kind=value but its companion rows were empty or unreadable. Refusing rather than inventing a history year.`,
    };
  }

  return {
    state: "present",
    source: VALUE_HISTORY_FACT_SOURCE,
    entityId: placeKey,
    entries,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
