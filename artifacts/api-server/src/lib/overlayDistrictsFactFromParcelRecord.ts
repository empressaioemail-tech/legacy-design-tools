/**
 * parcel_record -> OverlayDistrictsFactRead adapter (F-01, serve/prod
 * cutover, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Every companion row is a hit (unlike utilityService's fixed water/sewer
 * slots): rowIndex 0..N-1, sequential by discovery, one per matched overlay
 * polygon (parcel-overlay-districts.mjs's own writeOverlayResults). Payload
 * shape is `{city, ...tx_city_overlay.payload}` -- `city` is pulled out
 * explicitly as its own field; everything else passes through verbatim as
 * `attributes`, since the source's own shape is heterogeneous by design
 * (see overlayDistrictsFactRead.ts's module doc).
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader. `unaccounted` is never rendered as
 * an absence -- it becomes a distinct refusal code, matching the house
 * convention.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import {
  OVERLAY_DISTRICTS_FACT_SOURCE,
  OVERLAY_DISTRICTS_RAIL_KEY,
  type OverlayDistrictEntry,
  type OverlayDistrictsFactRead,
} from "./overlayDistrictsFactRead";

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

function cityNameFromBasis(basis: string | Record<string, unknown> | null): string | null {
  const rec = asRecord(basis);
  return rec ? asNullableString(rec.cityName) : null;
}

function districtFromCompanionRow(row: ParcelRecordCompanionRow): OverlayDistrictEntry | null {
  const rec = asRecord(row.payload);
  if (!rec) return null;
  const city = asNullableString(rec.city);
  if (!city) return null;
  const { city: _city, ...attributes } = rec;
  return { city, attributes };
}

export async function overlayDistrictsFactFromParcelRecord(
  parcelNodeId: string,
): Promise<OverlayDistrictsFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: OVERLAY_DISTRICTS_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, OVERLAY_DISTRICTS_RAIL_KEY);

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
      source: OVERLAY_DISTRICTS_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: OVERLAY_DISTRICTS_FACT_SOURCE,
      entityId: placeKey,
      cityName: cityNameFromBasis(cell.basis),
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: vintageFromBasis(cell.basis),
    };
  }

  // cell.state === "present"
  const districts = cell.companionRows
    .map(districtFromCompanionRow)
    .filter((d): d is OverlayDistrictEntry => d !== null);

  if (districts.length === 0) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: OVERLAY_DISTRICTS_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${OVERLAY_DISTRICTS_RAIL_KEY} is kind=value but its companion rows were empty or unreadable. Refusing rather than inventing an overlay.`,
    };
  }

  return {
    state: "present",
    source: OVERLAY_DISTRICTS_FACT_SOURCE,
    entityId: placeKey,
    districts,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
