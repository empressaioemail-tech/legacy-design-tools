/**
 * The PARCEL-B-SLATE2 integration point (F-01,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * Unlike wells/specialDistricts/cityLimits (slate-1: one legacy loader per
 * rail, a whole-function swap), the six dollar/structural rails do not admit
 * a whole-object swap:
 *
 *   - marketValue/assessedValue/landValue/improvementValue are baked into
 *     place_layer_snapshots (facets.baseFacts.cadRoll.*) by an offline job,
 *     not read live -- the legacy value is whatever the last bake wrote.
 *   - yearBuilt is ALSO baked (facets.baseFacts.yearBuilt) at
 *     brokerageNodeFacets.ts, but is served LIVE (via structuralFactRead.ts,
 *     bundled with livingAreaSqft) at propertyExplorer.ts -- two different
 *     legacy sources for the same rail, depending on call site.
 *   - livingAreaSqft is served live at both call sites via
 *     structuralFactRead.ts, bundled with yearBuilt in one read.
 *
 * This module resolves the allowlist for all six rails once per request
 * (parallel), and for each rail resolved to "record", fetches the
 * parcel_record-sourced value. Callers OVERLAY these onto whatever the
 * legacy path already produced -- never a whole-object swap -- and a rail
 * resolved to "legacy" or "refused" is represented as `null` here, meaning
 * "the caller must keep its own legacy value," not "no value exists."
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import {
  dollarFactFromParcelRecord,
  livingAreaSqftFromParcelRecord,
  yearBuiltFromParcelRecord,
  DOLLAR_SCALAR_RAIL_KEYS,
  type DollarScalarRailKey,
  type LivingAreaSqftFromParcelRecord,
  type YearBuiltFromParcelRecord,
} from "./cadRollFactFromParcelRecord";
import type { CadRollValueWire } from "./cadRollValue";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/** Test/deploy seam, same shape as wellFactServeCutover.ts's own. */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setCadRollVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetCadRollVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export type CadRollOverlay = {
  marketValue: CadRollValueWire | null;
  assessedValue: CadRollValueWire | null;
  landValue: CadRollValueWire | null;
  improvementValue: CadRollValueWire | null;
  livingAreaSqft: LivingAreaSqftFromParcelRecord;
  yearBuilt: YearBuiltFromParcelRecord;
};

async function dollarOverlayIfRecord(
  store: ParcelRecordQueryable | null,
  countyFips: string,
  propId: string,
  railKey: DollarScalarRailKey,
): Promise<CadRollValueWire | null> {
  const state = await resolveAllowlist(store, countyFips, railKey);
  if (state !== "record") return null;
  return dollarFactFromParcelRecord(countyFips, propId, railKey);
}

async function livingAreaOverlayIfRecord(
  store: ParcelRecordQueryable | null,
  countyFips: string,
  propId: string,
): Promise<LivingAreaSqftFromParcelRecord> {
  const state = await resolveAllowlist(store, countyFips, "livingAreaSqft");
  if (state !== "record") return null;
  return livingAreaSqftFromParcelRecord(countyFips, propId);
}

async function yearBuiltOverlayIfRecord(
  store: ParcelRecordQueryable | null,
  countyFips: string,
  propId: string,
): Promise<YearBuiltFromParcelRecord> {
  const state = await resolveAllowlist(store, countyFips, "yearBuilt");
  if (state !== "record") return null;
  return yearBuiltFromParcelRecord(countyFips, propId);
}

/**
 * Resolve every slate-2 rail's overlay for one parcel, in parallel. Each
 * field is `null` (or `{status:"absent-in-record"}`/absent-wire for the two
 * fields whose own "no value" shape is distinct from "not cut over") when
 * the caller should keep its legacy value -- either not slated, verdict
 * refused/excluded, or the parcel_record cell itself refused/miscoerced.
 */
export async function resolveCadRollOverlaysForServe(
  countyFips: string,
  propId: string,
): Promise<CadRollOverlay> {
  const store = resolveVerdictStore(injectedVerdictStore);
  const [marketValue, assessedValue, landValue, improvementValue, livingAreaSqft, yearBuilt] =
    await Promise.all([
      dollarOverlayIfRecord(store, countyFips, propId, "marketValue"),
      dollarOverlayIfRecord(store, countyFips, propId, "assessedValue"),
      dollarOverlayIfRecord(store, countyFips, propId, "landValue"),
      dollarOverlayIfRecord(store, countyFips, propId, "improvementValue"),
      livingAreaOverlayIfRecord(store, countyFips, propId),
      yearBuiltOverlayIfRecord(store, countyFips, propId),
    ]);
  return { marketValue, assessedValue, landValue, improvementValue, livingAreaSqft, yearBuilt };
}

export { DOLLAR_SCALAR_RAIL_KEYS };
