/**
 * parcel_record -> WellFactRead adapter (F-01, PARCEL-B-SLATE1,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * COVERAGE DIFFERENCE FROM THE LEGACY ATOM -- DISCLOSED, NOT HIDDEN. The
 * legacy well-fact atom (wellFactRead.ts) reports both on-parcel wells AND
 * near-parcel wells within a 152m search radius (see its own CRANE fixture,
 * proximityRadiusMeters: 152). parcel_record's `wells` rail is a pure
 * point-in-polygon containment sweep -- R4's own mission spec
 * (doc_repo:_catalog/dispatch_missions/mission_parcel_r4_companions.md:
 * "Spatial join to parcel geometry", zone-major, no buffer, no radius) --
 * and has NO near-parcel concept at all. Every well this adapter reports is
 * therefore `parcelRelation: "on-parcel"` by construction;
 * proximityRadiusMeters, proximityDistanceMeters, and surfaceLocation are
 * honestly null (not computed by this source, never fabricated). A parcel
 * whose only well is near-parcel-not-on-parcel on the legacy atom will show
 * absent here -- a real, disclosed coverage narrowing that the pre-flip
 * divergence test is expected to surface, not a defect in this adapter.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader -- no separate store configuration
 * here; this module is pure translation from that generic 3-state
 * (present/absent/refused) cell shape into WellFactRead's richer union.
 * `unaccounted` is never rendered as an absence -- it becomes a distinct
 * refusal code, per parcel_record's own "unaccounted never reaches the wire
 * as a fabricated absence" contract.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import type { ParcelRecordCompanionRow } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";
import { WELL_FACT_SOURCE, type WellFactRead, type WellFactWell } from "./wellFactRead";

export const WELLS_RAIL_KEY = "wells" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** basis can be a plain string, a structured object, or null -- always produce a human string. */
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

/**
 * One companion row -> one WellFactWell. `wellType` and `operatorName` are
 * honestly null -- the parcel_record wells companion payload
 * ({api, isOrphan, wellStatus, gisWellNumber}, live-verified 2026-09-02)
 * carries neither field; this is not computed by that source, not
 * withheld by this adapter.
 */
function wellFromCompanionRow(
  placeKey: string,
  row: ParcelRecordCompanionRow,
): WellFactWell | null {
  const rec = asRecord(row.payload);
  if (!rec) return null;
  const api = asNullableString(rec.api);
  const wellKey = api ?? `row-${row.rowIndex}`;
  return {
    entityId: `${placeKey}:${wellKey}`,
    wellKey,
    apiNumber14: api,
    wellStatus: asNullableString(rec.wellStatus),
    wellType: null,
    orphaned: asNullableBoolean(rec.isOrphan),
    operatorName: null,
    parcelRelation: "on-parcel",
    proximityRadiusMeters: null,
    proximityDistanceMeters: null,
    surfaceLocation: null,
  };
}

/**
 * Every well from this source has parcelRelation "on-parcel" and a null
 * proximityDistanceMeters (see module comment) -- the legacy leadWell()
 * sort therefore reduces exactly to its own wellKey.localeCompare
 * tie-break for this source's inputs; reproduced directly rather than
 * importing a private helper.
 */
function leadWellFromParcelRecord(wells: WellFactWell[]): WellFactWell {
  return [...wells].sort((a, b) => a.wellKey.localeCompare(b.wellKey))[0];
}

export async function wellFactFromParcelRecord(parcelNodeId: string): Promise<WellFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: WELL_FACT_SOURCE,
      tried: [],
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const tried: readonly [string, string] = [placeKey, placeKey];
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, WELLS_RAIL_KEY);

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
      source: WELL_FACT_SOURCE,
      tried,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: WELL_FACT_SOURCE,
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
  const wells = cell.companionRows
    .map((row) => wellFromCompanionRow(placeKey, row))
    .filter((w): w is WellFactWell => w !== null);

  if (wells.length === 0) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: WELL_FACT_SOURCE,
      tried,
      reason: `parcel_record_cell ${placeKey}/${WELLS_RAIL_KEY} is kind=value but its companion rows were empty or unreadable. Refusing rather than inventing a well.`,
    };
  }

  const lead = leadWellFromParcelRecord(wells);
  return {
    state: "present",
    source: WELL_FACT_SOURCE,
    boundAs: placeKey,
    tried,
    entityId: placeKey,
    wellKey: lead.wellKey,
    apiNumber14: lead.apiNumber14,
    wellStatus: lead.wellStatus,
    wellType: lead.wellType,
    orphaned: lead.orphaned,
    operatorName: lead.operatorName,
    parcelRelation: lead.parcelRelation,
    proximityRadiusMeters: lead.proximityRadiusMeters,
    proximityDistanceMeters: lead.proximityDistanceMeters,
    surfaceLocation: lead.surfaceLocation,
    wells,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
