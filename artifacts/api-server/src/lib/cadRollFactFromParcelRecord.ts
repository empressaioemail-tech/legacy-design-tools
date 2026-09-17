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
 *
 * P-269 (folded into P-297, operator ruling A-193, 2026-09-16): THIS FILE
 * USED TO CONVERT A REFUSAL INTO A SILENT FALLBACK. All four scalar readers
 * below returned `null` for a `refused` cell (unaccounted, engine-refused,
 * cell-miss, malformed-cell, store-not-configured), so the caller kept the
 * legacy/baked value and the customer saw a number that the live store had
 * explicitly declined to assert. `resolveValueBasisFromParcelRecord` did the
 * same thing differently: it defaulted to `stratmap-redistributed` whenever
 * assessedValue was not a present dollar, so a provenance label nothing had
 * verified rode out on a refused cell.
 *
 * Under the ruling a refusal is NOT a null to fall back on: on a slated rail
 * the refusal IS the answer, carrying the cell's own reason. So:
 *
 *   - each reader returns {@link CadRollParcelRecordRefusal} (a fourth
 *     `state` on the same shape family as CadRollValueWire's three) for a
 *     refused cell, and for a `value` cell whose payload does not coerce into
 *     its own rail's domain -- a `malformed-cell` refusal, not a null;
 *   - `null` from these readers now means exactly ONE thing: this parcel has
 *     no live answer on this rail and the caller's own pre-cutover path is
 *     the correct answer (the callers reach that conclusion from the slate,
 *     never from this module);
 *   - `resolveValueBasisFromParcelRecord` returns `null` -- "the store
 *     asserts nothing about assessedValue" -- and the dollar wires simply
 *     carry no `valueBasis` in that case.
 */

import {
  loadParcelRecordCell,
  type ParcelRecordCellRefusal,
  type ParcelRecordCellRefusalCode,
} from "./parcelRecordCellRead";
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

/**
 * The cell reader's five refusal codes, named for the wire. Deliberately
 * prefixed rather than re-using the reader's bare words: a serialized
 * `"unaccounted"` on a facet is still the pipeline word
 * `_decisions/2026-09-01_serve_path_never_emits_pipeline_state.md` forbids,
 * and the reader's `"no-such-parcel-or-rail"` would read as a claim about
 * parcel existence rather than about this rail's row. One stable mapping,
 * used by every scalar reader here, so the dollar rails, sqft, and yearBuilt
 * all name the same refusal the same way.
 */
export const PARCEL_RECORD_REFUSAL_CODES = {
  unaccounted: "parcel-record-unaccounted",
  "engine-refused": "parcel-record-engine-refused",
  "no-such-parcel-or-rail": "parcel-record-cell-miss",
  "malformed-cell": "parcel-record-malformed-cell",
  "store-not-configured": "parcel-record-store-not-configured",
} as const satisfies Record<ParcelRecordCellRefusalCode, string>;

export type CadRollParcelRecordRefusalCode =
  (typeof PARCEL_RECORD_REFUSAL_CODES)[ParcelRecordCellRefusalCode];

/**
 * The declared refusal a slated rail serves in place of a value. Same shape
 * family as {@link CadRollValueWire}'s own `state` discriminant, so a
 * consumer that already switches on `.state` gets a fourth case rather than
 * an unannounced shape -- exactly like {@link CadRollValuationRefusal}'s
 * `studio-gated` sibling in cadRollValue.ts. The two are distinguishable by
 * `code` and can coexist on one response (a gated caller's dollar fields are
 * replaced by the studio-gated refusal AFTER the overlay is merged).
 */
export type CadRollParcelRecordRefusal = {
  state: "refused";
  code: CadRollParcelRecordRefusalCode;
  reason: string;
};

export type CadRollServedDollarWire = CadRollValueWire | CadRollParcelRecordRefusal;

/** The four dollar rails' own served-field type, named once for the overlay. */
export type CadRollServedDollarField = CadRollServedDollarWire | null;

export function parcelRecordRefusalFromCell(
  cell: ParcelRecordCellRefusal,
): CadRollParcelRecordRefusal {
  return {
    state: "refused",
    code: PARCEL_RECORD_REFUSAL_CODES[cell.code],
    reason: cell.reason,
  };
}

function reasonFromBasis(basis: string | Record<string, unknown> | null): string {
  if (typeof basis === "string") return basis;
  if (basis && typeof basis === "object") {
    const finding = (basis as Record<string, unknown>).finding;
    if (typeof finding === "string" && finding.trim()) return finding;
    return JSON.stringify(basis);
  }
  return "parcel_record marked this cell absent with no basis recorded.";
}

function malformedCellRefusal(
  railKey: string,
  detail: string,
): CadRollParcelRecordRefusal {
  return {
    state: "refused",
    code: PARCEL_RECORD_REFUSAL_CODES["malformed-cell"],
    reason:
      `parcel_record marks the ${railKey} cell as a value, but ${detail}. ` +
      "Refusing rather than serving it, and rather than falling back to the legacy value on a slated rail.",
  };
}

/**
 * One dollar rail (marketValue/assessedValue/landValue/improvementValue).
 * Mirrors cadRollValue.ts's own CadRollValueWire three-state contract for an
 * earned answer, and adds {@link CadRollParcelRecordRefusal} as the fourth
 * state for a slated rail the store would not answer for.
 *
 * `valueBasis` is passed in rather than re-derived per rail (CTX-B1,
 * operator ruling A1): it is one determination per parcel, computed once by
 * {@link resolveValueBasisFromParcelRecord} and shared across all four
 * dollar rails so a parcel cannot serve marketValue as county-assessed and
 * landValue as stratmap-redistributed from the same row. It is `null` when
 * the store asserts nothing about assessedValue -- a refused/unaccounted
 * cell -- and is then simply omitted from the wire (the field is optional)
 * rather than defaulted to a label nobody verified.
 */
export async function dollarFactFromParcelRecord(
  countyFips: string,
  propId: string,
  railKey: DollarScalarRailKey,
  valueBasis: ValueBasis | null,
): Promise<CadRollServedDollarWire> {
  const cell = await loadParcelRecordCell(countyFips, propId, railKey);
  if (cell.state === "refused") return parcelRecordRefusalFromCell(cell);
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
    // non-negative dollar amount. A malformed cell is a declared refusal.
    return malformedCellRefusal(
      railKey,
      `its payload does not coerce to a non-negative dollar amount (${JSON.stringify(cell.value)})`,
    );
  }
  const basisField = valueBasis == null ? {} : { valueBasis };
  if (dollars === 0) {
    return {
      state: "zero",
      v: 0,
      source: CAD_PROPERTY_SOURCE,
      vintage: cell.vintage || null,
      ...basisField,
    };
  }
  return {
    state: "present",
    v: dollars,
    source: CAD_PROPERTY_SOURCE,
    vintage: cell.vintage || null,
    ...basisField,
  };
}

/**
 * CTX-B1 (operator ruling A1): the same assessed-value discriminator as the
 * bake path (`cadRollValue.ts`'s `valueBasisFromRow`), applied to the live
 * parcel_record overlay. Reads the assessedValue cell directly -- never
 * gated by that rail's own slate entry -- because this is a tier
 * determination, not a value serve: whether or not assessedValue itself is
 * cut over to live serving for this parcel, its presence in the store is
 * still positive evidence of a genuine CAD-district export (the StratMap
 * adapter structurally cannot populate it).
 *
 * P-269's CP1 answer (2026-09-16), from ruling A1 plus the StratMap
 * adapter's own reach: the label may be asserted ONLY on evidence, and the
 * evidence is the cell's own state.
 *
 *   - a present, coercible non-negative dollar -> `county-assessed`. That is
 *     the positive evidence A1 named: the StratMap redistribution adapter
 *     structurally cannot populate assessedValue, so its presence cannot
 *     have come from redistribution.
 *   - an `absent` cell, either verdict -> `stratmap-redistributed`, and this
 *     is NOT a default. An absent-verified assessedValue cell is the store's
 *     positive finding that the parcel carries no CAD-district export on
 *     this rail; A1's discriminator is about where a dollar could have come
 *     from, and "this row carries no county-assessed dollar" is exactly what
 *     the redistribution label asserts. This is the pre-P-269 behavior for
 *     the absent case, preserved deliberately -- the dispatch required the
 *     CP1 answer before changing it, and the answer is that no change is
 *     earned here.
 *   - a `refused` cell, or a `value` cell that does not coerce -> `null`.
 *     The store has asserted NOTHING about assessedValue for this parcel, so
 *     no label is written at all. This is the change P-269 makes: the old
 *     code asserted `stratmap-redistributed` here, which was a publisher's
 *     label riding on an answer nobody gave.
 */
export async function resolveValueBasisFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<ValueBasis | null> {
  const cell = await loadParcelRecordCell(countyFips, propId, "assessedValue");
  if (cell.state === "refused") return null;
  if (cell.state === "absent") return STRATMAP_REDISTRIBUTED_VALUE_BASIS;
  if (nonNegativeDollarOrNull(cell.value) != null) return COUNTY_ASSESSED_VALUE_BASIS;
  return null;
}

export type LivingAreaSqftFromParcelRecord =
  | { status: "populated"; value: number }
  | { status: "absent-in-record" }
  | CadRollParcelRecordRefusal
  | null;

/**
 * livingAreaSqft as a bare positive-or-absent number (never zero, per
 * cadRollValue.ts's own positiveSqftOrNull contract) -- the caller (the
 * structural overlay) fits this into whichever absence-wire shape its own
 * call site already uses; this module does not know the LayerAbsenceWire
 * construction rules. A refused cell, or a present cell whose payload is not
 * a positive sqft, is a declared refusal (P-269) -- the wire shape for it is
 * built at the call site, which is the only place that knows whether it is
 * emitting a LayerAbsenceWire or a structural fact.
 */
export async function livingAreaSqftFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<LivingAreaSqftFromParcelRecord> {
  const cell = await loadParcelRecordCell(countyFips, propId, "livingAreaSqft");
  if (cell.state === "refused") return parcelRecordRefusalFromCell(cell);
  if (cell.state === "absent") return { status: "absent-in-record" };
  const sqft = positiveSqftOrNull(cell.value);
  if (sqft == null) {
    return malformedCellRefusal(
      "livingAreaSqft",
      `it does not carry a positive square footage (${JSON.stringify(cell.value)})`,
    );
  }
  return { status: "populated", value: sqft };
}

export type YearBuiltFromParcelRecord =
  | { v: number; source: typeof PARCEL_RECORD_CAD_SOURCE; vintage: string | null }
  | CadRollParcelRecordRefusal
  | null;

/**
 * yearBuilt: a real positive year, a declared refusal, or `null` -- and
 * `null` now covers exactly one case: an `absent` cell, i.e. the store
 * states this parcel carries no year on this rail. That is a stated absence
 * expressed in the only shape this rail's own contract has (`null`, the same
 * thing the offline bake means by a missing year -- CadRollBakedYear has no
 * absence variant and the StructuralFactPresent field is `number | null`).
 * Never zero: a year of 0 is not a real value, it is a malformed cell (P-269
 * refuses it rather than passing it through as a number).
 */
export async function yearBuiltFromParcelRecord(
  countyFips: string,
  propId: string,
): Promise<YearBuiltFromParcelRecord> {
  const cell = await loadParcelRecordCell(countyFips, propId, "yearBuilt");
  if (cell.state === "refused") return parcelRecordRefusalFromCell(cell);
  if (cell.state === "absent") return null;
  const year =
    typeof cell.value === "number"
      ? cell.value
      : typeof cell.value === "string" && cell.value.trim() !== ""
        ? Number(cell.value)
        : null;
  if (year == null || !Number.isFinite(year) || year <= 0) {
    return malformedCellRefusal(
      "yearBuilt",
      `it does not carry a real positive year (${JSON.stringify(cell.value)})`,
    );
  }
  return { v: Math.round(year), source: PARCEL_RECORD_CAD_SOURCE, vintage: cell.vintage || null };
}

/** True when one of these readers' answers is a declared refusal rather than an earned value. */
export function isParcelRecordRefusal(
  value:
    | CadRollServedDollarWire
    | LivingAreaSqftFromParcelRecord
    | YearBuiltFromParcelRecord,
): value is CadRollParcelRecordRefusal {
  return value != null && "state" in value && value.state === "refused";
}
