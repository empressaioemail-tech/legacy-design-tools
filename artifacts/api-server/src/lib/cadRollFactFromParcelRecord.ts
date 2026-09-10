/**
 * parcel_record -> CadRoll/structural scalar adapter (F-01, PARCEL-B-SLATE2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Unlike wells/specialDistricts (companion-row rails), the six rails this card
 * cuts over -- marketValue, assessedValue, landValue, improvementValue,
 * livingAreaSqft, yearBuilt -- are scalar `value` cells in parcel_record_cell
 * (ParcelRecordCellPresent.value: string | number | boolean | null,
 * companionRows always empty; confirmed live 2026-09-03 against gold
 * 48021:34137 and the Williamson pair R664999/R665023). One generic reader
 * covers all six; each rail keeps ITS OWN existing wire shape (CadRollValueWire
 * for the four dollar fields, LivingAreaSqftLayerWire-compatible for sqft,
 * CadRollBakedYear-compatible for year) rather than inventing a seventh shape.
 *
 * Dollar cell values are stored as STRINGS ("404630"), not numbers -- verified
 * live. yearBuilt is stored as a raw number. Reuses cadRollValue.ts's own
 * coercion functions (nonNegativeDollarOrNull, positiveSqftOrNull) so a
 * parcel_record-sourced value is held to the exact same 0-vs-absent and
 * negative-vs-absent rules as the legacy cad_property-sourced value --
 * required for the divergence test to compare like with like.
 */

import { loadParcelRecordCell } from "./parcelRecordCellRead";
import {
  CAD_PROPERTY_SOURCE,
  COUNTY_ASSESSED_VALUE_BASIS,
  STRATMAP_REDISTRIBUTED_VALUE_BASIS,
  nonNegativeDollarOrNull,
  positiveSqftOrNull,
  type CadRollValueWire,
  type ValueBasis,
} from "./cadRollValue";

export const PARCEL_RECORD_CAD_SOURCE = "parcel_record" as const;

export const DOLLAR_SCALAR_RAIL_KEYS = [
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
] as const;
export type DollarScalarRailKey = (typeof DOLLAR_SCALAR_RAIL_KEYS)[number];

function reasonFromBasis(basis: string | Record<string, unknown> | null): string {
  if (typeof basis === "string") return basis;
  if (basis && typeof basis === "object") {
    const finding = (basis as Record<string, unknown>).finding;
    if (typeof finding === "string" && finding.trim()) return finding;
    return JSON.stringify(basis);
  }
  return "parcel_record marked this cell absent with no basis recorded.";
}

/**
 * One dollar rail (marketValue/assessedValue/landValue/improvementValue).
 * Mirrors cadRollValue.ts's own CadRollValueWire three-state contract exactly
 * so a serve-layer overlay is a drop-in value swap, not a shape change.
 * `refused` cells (unaccounted, engine-refused, store-not-configured, etc.)
 * fall back to `null` -- the caller keeps the legacy value in that case,
 * same as a slate-miss; refusal is not this wire's own fourth state.
 *
 * `valueBasis` is passed in rather than re-derived per rail (CTX-B1,
 * operator ruling A1): it is one determination per parcel, computed once by
 * {@link resolveValueBasisFromParcelRecord} and shared across all four
 * dollar rails so a parcel cannot serve marketValue as county-assessed and
 * landValue as stratmap-redistributed from the same row.
 */
export async function dollarFactFromParcelRecord(
  countyFips: string,
  propId: string,
  railKey: DollarScalarRailKey,
  valueBasis: ValueBasis,
): Promise<CadRollValueWire | null> {
  const cell = await loadParcelRecordCell(countyFips, propId, railKey);
  if (cell.state === "refused") return null;
  if (cell.state === "absent") {
    return {
      state: "absent",
      source: CAD_PROPERTY_SOURCE,
      vintage: null,
      basis: reasonFromBasis(cell.basis),
    };
  }
  const dollars = nonNegativeDollarOrNull(cell.value);
  if (dollars == null) {
    // The cell says "value" but the payload does not coerce to a real
    // non-negative dollar amount. Refuse to fabricate -- caller keeps legacy.
    return null;
  }
  if (dollars === 0) {
    return {
      state: "zero",
      v: 0,
      source: CAD_PROPERTY_SOURCE,
      vintage: cell.vintage || null,
      valueBasis,
    };
  }
  return {
    state: "present",
    v: dollars,
    source: CAD_PROPERTY_SOURCE,
    vintage: cell.vintage || null,
    valueBasis,
  };
}

/**
 * CTX-B1 (operator ruling A1): the same assessed-value discriminator as the
 * bake path (`cadRollValue.ts`'s `valueBasisFromRow`), applied to the live
 * parcel_record overlay. Reads the assessedValue cell directly -- never
 * gated by that rail's own allowlist state -- because this is a tier
 * determination, not a value serve: whether or not assessedValue itself is
 * cut over to live serving for this parcel, its presence in the store is
 * still positive evidence of a genuine CAD-district export (the StratMap
 * adapter structurally cannot populate it). Anything other than a present,
 * coercible non-negative dollar (absent, refused, not-applicable,
 * unaccounted, malformed) defaults to stratmap-redistributed -- this must
 * never assert county-assessed without the evidence.
 */
export async function resolveValueBasisFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<ValueBasis> {
  const cell = await loadParcelRecordCell(countyFips, propId, "assessedValue");
  if (cell.state === "present" && nonNegativeDollarOrNull(cell.value) != null) {
    return COUNTY_ASSESSED_VALUE_BASIS;
  }
  return STRATMAP_REDISTRIBUTED_VALUE_BASIS;
}

export type LivingAreaSqftFromParcelRecord =
  | { status: "populated"; value: number }
  | { status: "absent-in-record" }
  | null;

/**
 * livingAreaSqft as a bare positive-or-absent number (never zero, per
 * cadRollValue.ts's own positiveSqftOrNull contract) -- the caller (the
 * structural overlay) fits this into whichever absence-wire shape its own
 * call site already uses; this module does not know the LayerAbsenceWire
 * construction rules.
 */
export async function livingAreaSqftFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<LivingAreaSqftFromParcelRecord> {
  const cell = await loadParcelRecordCell(countyFips, propId, "livingAreaSqft");
  if (cell.state === "refused") return null;
  if (cell.state === "absent") return { status: "absent-in-record" };
  const sqft = positiveSqftOrNull(cell.value);
  if (sqft == null) return null;
  return { status: "populated", value: sqft };
}

export type YearBuiltFromParcelRecord = {
  v: number;
  source: typeof PARCEL_RECORD_CAD_SOURCE;
  vintage: string | null;
} | null;

/** yearBuilt: a raw positive year or null. Never zero (a year of 0 is not a real value). */
export async function yearBuiltFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<YearBuiltFromParcelRecord> {
  const cell = await loadParcelRecordCell(countyFips, propId, "yearBuilt");
  if (cell.state !== "present") return null;
  const year =
    typeof cell.value === "number"
      ? cell.value
      : typeof cell.value === "string" && cell.value.trim() !== ""
        ? Number(cell.value)
        : null;
  if (year == null || !Number.isFinite(year) || year <= 0) return null;
  return { v: Math.round(year), source: PARCEL_RECORD_CAD_SOURCE, vintage: cell.vintage || null };
}
