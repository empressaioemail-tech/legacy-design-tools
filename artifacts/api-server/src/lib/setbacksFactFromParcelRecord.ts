/**
 * parcel_record -> SetbacksFactRead adapter (F-01, PARCEL-B-SLATE3, OPS-16
 * A-096/A-097/A-098, `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Mirrors zoningFactFromParcelRecord.ts's own shape for the sibling
 * "setbacks-envelope" section: four independent scalar parcel_record rail
 * keys (setbackFrontFt, setbackSideFt, setbackRearFt, setbackCornerFt) that
 * hauska-factory's rail-keys.js (UNINCORPORATED_NOT_APPLICABLE_RAIL_KEYS)
 * writes identically for an unincorporated parcel -- {kind:"not-applicable",
 * reason: UNINCORPORATED_ZONING_REASON} on all four -- at row-creation time
 * (instantiate.js). This adapter gates the whole determination on
 * setbackFrontFt's own cell state (representative key, same reasoning as
 * zoningFactFromParcelRecord.ts's own district-gates-the-group choice);
 * side/rear/corner are read from their OWN cells honestly, never inferred
 * from front's.
 *
 * Reads via loadParcelRecordCell (parcelRecordCellRead.ts), the SELECT-only
 * parcel_record_ro-credentialed reader shared with every other rail adapter.
 * `unaccounted` is never rendered as an absence -- it becomes a distinct
 * refusal code, matching this repo's own house convention.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import { parseParcelNodeId } from "./parcelNodeId";

export const SETBACKS_FACT_SOURCE = "setbacks-fact-parcel-record" as const;
export const SETBACK_FRONT_FT_RAIL_KEY = "setbackFrontFt" as const;
export const SETBACK_SIDE_FT_RAIL_KEY = "setbackSideFt" as const;
export const SETBACK_REAR_FT_RAIL_KEY = "setbackRearFt" as const;
export const SETBACK_CORNER_FT_RAIL_KEY = "setbackCornerFt" as const;
export const SETBACK_RAIL_KEYS = [
  SETBACK_FRONT_FT_RAIL_KEY,
  SETBACK_SIDE_FT_RAIL_KEY,
  SETBACK_REAR_FT_RAIL_KEY,
  SETBACK_CORNER_FT_RAIL_KEY,
] as const;

export type SetbacksFactPresent = {
  state: "present";
  source: typeof SETBACKS_FACT_SOURCE;
  entityId: string;
  frontFt: number | null;
  sideFt: number | null;
  rearFt: number | null;
  cornerFt: number | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type SetbacksFactAbsent = {
  state: "absent";
  source: typeof SETBACKS_FACT_SOURCE;
  entityId: string;
  absence: { kind: "absent-verified" | "not-applicable"; reason: string };
  /** true only for a genuine "swept, found nothing" absent-verified; null for not-applicable -- matches every sibling adapter's own verifiedAbsence convention. */
  verifiedAbsence: boolean | null;
  sourceTier: string | null;
  sourceAdapter: "parcel_record";
  sourceVintage: string | null;
};

export type SetbacksFactRefusalCode =
  | "invalid-parcel-node-id"
  | "parcel-record-unaccounted"
  | "parcel-record-engine-refused"
  | "parcel-record-cell-miss"
  | "parcel-record-malformed-cell"
  | "parcel-record-store-not-configured";

export type SetbacksFactRefusal = {
  state: "refused";
  code: SetbacksFactRefusalCode;
  source: typeof SETBACKS_FACT_SOURCE;
  entityId: string | null;
  reason: string;
};

export type SetbacksFactRead = SetbacksFactPresent | SetbacksFactAbsent | SetbacksFactRefusal;

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
 * Best-effort scalar numeric read of a sibling setback rail cell -- honestly
 * null on anything but a real present finite number. Never throws, never
 * fabricates.
 */
async function scalarNumberOrNull(
  countyFips: string,
  propId: string,
  railKey: string,
): Promise<number | null> {
  const cell = await loadParcelRecordCell(countyFips, propId, railKey);
  if (cell.state !== "present") return null;
  return typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
}

export async function setbacksFactFromParcelRecord(parcelNodeId: string): Promise<SetbacksFactRead> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    return {
      state: "refused",
      code: "invalid-parcel-node-id",
      source: SETBACKS_FACT_SOURCE,
      entityId: null,
      reason: `"${parcelNodeId}" is not a valid parcel node id (county_fips:prop_id). Refusing rather than guessing a place_key.`,
    };
  }
  const placeKey = `${parsed.countyFips}:${parsed.propId}`;
  const cell = await loadParcelRecordCell(parsed.countyFips, parsed.propId, SETBACK_FRONT_FT_RAIL_KEY);

  if (cell.state === "refused") {
    return {
      state: "refused",
      code: REFUSAL_CODE_MAP[cell.code],
      source: SETBACKS_FACT_SOURCE,
      entityId: placeKey,
      reason: cell.reason,
    };
  }

  if (cell.state === "absent") {
    return {
      state: "absent",
      source: SETBACKS_FACT_SOURCE,
      entityId: placeKey,
      absence: { kind: cell.verdict, reason: reasonFromBasis(cell.basis) },
      verifiedAbsence: cell.verdict === "absent-verified" ? true : null,
      sourceTier: methodFromBasis(cell.basis),
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
  }

  // cell.state === "present"
  const frontFt = typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
  if (frontFt == null) {
    return {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: SETBACKS_FACT_SOURCE,
      entityId: placeKey,
      reason: `parcel_record_cell ${placeKey}/${SETBACK_FRONT_FT_RAIL_KEY} is kind=value but its value is not a readable number. Refusing rather than inventing one.`,
    };
  }
  const [sideFt, rearFt, cornerFt] = await Promise.all([
    scalarNumberOrNull(parsed.countyFips, parsed.propId, SETBACK_SIDE_FT_RAIL_KEY),
    scalarNumberOrNull(parsed.countyFips, parsed.propId, SETBACK_REAR_FT_RAIL_KEY),
    scalarNumberOrNull(parsed.countyFips, parsed.propId, SETBACK_CORNER_FT_RAIL_KEY),
  ]);
  return {
    state: "present",
    source: SETBACKS_FACT_SOURCE,
    entityId: placeKey,
    frontFt,
    sideFt,
    rearFt,
    cornerFt,
    sourceAdapter: "parcel_record",
    sourceVintage: cell.vintage || null,
    evaluatedAt: cell.vintage || null,
  };
}
