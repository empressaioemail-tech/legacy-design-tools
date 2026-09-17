/**
 * Serve-layer cutover wrapper for the CAD roll dollar rails + yearBuilt +
 * livingAreaSqft (F-01, PARCEL-B-SLATE2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict gate
 * this file used to apply. Until P-297 this module asked `resolveAllowlist`
 * once per rail and served the record's own answer only on `record`, which
 * required a PASSING county gate verdict -- so ONE unaccounted cell anywhere
 * in a slated county turned all four dollar rails, sqft and yearBuilt back to
 * the offline bake for EVERY parcel in that county. The verdict is a
 * completeness and publish grade; it stopped deciding what a parcel shows.
 *
 * The decision now comes from PARCEL_RECORD_SLATE and the parcel's OWN cell,
 * through the one rule in `cellServeRule.ts`:
 *
 *   - a rail whose (county, rail) pair is NOT in the slate -> `null` for that
 *     rail, meaning "the caller's own pre-cutover path is the answer"
 *     (propertyExplorer/brokerageNodeFacets keep their baked
 *     baseFacts.cadRoll / structural fields), and NO parcel_record I/O runs
 *     for it at all;
 *   - a slated rail -> this parcel's own cell, served AS-IS: a value with its
 *     source and vintage, a stated absence with its reason, or a declared
 *     refusal carrying the cell's reason (P-269). Never the baked value.
 *
 * `resolveValueBasisFromParcelRecord` (the CTX-B1/A1 tier determination) runs
 * only when at least one dollar rail is actually slated, and returns `null`
 * when the store asserts nothing -- so the label is never defaulted onto a
 * refused cell, and an unslated parcel does not pay for the read.
 *
 * The county verdict is no longer read on this path at all;
 * `cellServeRule.test.ts` fails if this file imports the verdict reader again.
 */

import { isSlatedForCellServe } from "./cellServeRule";
import {
  DOLLAR_SCALAR_RAIL_KEYS,
  dollarFactFromParcelRecord,
  livingAreaSqftFromParcelRecord,
  resolveValueBasisFromParcelRecord,
  yearBuiltFromParcelRecord,
  type CadRollServedDollarField,
  type DollarScalarRailKey,
  type LivingAreaSqftFromParcelRecord,
  type YearBuiltFromParcelRecord,
} from "./cadRollFactFromParcelRecord";
import type { ValueBasis } from "./cadRollValue";

export type CadRollOverlay = {
  marketValue: CadRollServedDollarField;
  assessedValue: CadRollServedDollarField;
  landValue: CadRollServedDollarField;
  improvementValue: CadRollServedDollarField;
  livingAreaSqft: LivingAreaSqftFromParcelRecord;
  yearBuilt: YearBuiltFromParcelRecord;
};

async function dollarOverlayIfSlated(
  countyFips: string,
  propId: string,
  railKey: DollarScalarRailKey,
  valueBasis: ValueBasis | null,
): Promise<CadRollServedDollarField> {
  if (!isSlatedForCellServe(countyFips, railKey)) return null;
  return dollarFactFromParcelRecord(countyFips, propId, railKey, valueBasis);
}

async function livingAreaOverlayIfSlated(
  countyFips: string,
  propId: string,
): Promise<LivingAreaSqftFromParcelRecord> {
  if (!isSlatedForCellServe(countyFips, "livingAreaSqft")) return null;
  return livingAreaSqftFromParcelRecord(countyFips, propId);
}

async function yearBuiltOverlayIfSlated(
  countyFips: string,
  propId: string,
): Promise<YearBuiltFromParcelRecord> {
  if (!isSlatedForCellServe(countyFips, "yearBuilt")) return null;
  return yearBuiltFromParcelRecord(countyFips, propId);
}

/**
 * Resolve the six parcel_record-sourced fields this rail group serves.
 *
 * No store parameter and no test seam of its own any more: the reads go
 * through `parcelRecordCellRead.ts`'s own `setParcelRecordQueryableForTests`
 * injection (the same seam every rail adapter already uses), because the
 * decision no longer involves a county verdict store at all.
 */
export async function resolveCadRollOverlaysForServe(
  countyFips: string,
  propId: string,
): Promise<CadRollOverlay> {
  const anyDollarSlated = DOLLAR_SCALAR_RAIL_KEYS.some((railKey) =>
    isSlatedForCellServe(countyFips, railKey),
  );
  // One tier determination per parcel (CTX-B1/A1), never re-derived per rail
  // -- and never computed at all when no dollar rail is slated to serve.
  const valueBasis = anyDollarSlated
    ? await resolveValueBasisFromParcelRecord(countyFips, propId)
    : null;
  const [marketValue, assessedValue, landValue, improvementValue, livingAreaSqft, yearBuilt] =
    await Promise.all([
      dollarOverlayIfSlated(countyFips, propId, "marketValue", valueBasis),
      dollarOverlayIfSlated(countyFips, propId, "assessedValue", valueBasis),
      dollarOverlayIfSlated(countyFips, propId, "landValue", valueBasis),
      dollarOverlayIfSlated(countyFips, propId, "improvementValue", valueBasis),
      livingAreaOverlayIfSlated(countyFips, propId),
      yearBuiltOverlayIfSlated(countyFips, propId),
    ]);
  return { marketValue, assessedValue, landValue, improvementValue, livingAreaSqft, yearBuilt };
}

export { DOLLAR_SCALAR_RAIL_KEYS };
