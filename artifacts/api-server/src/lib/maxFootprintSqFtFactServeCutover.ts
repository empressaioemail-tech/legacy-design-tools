/**
 * Serve-layer cutover wrapper for maxFootprintSqFt (F-01, OPS-21 P-148 /
 * P-133), on the allowlist pattern maxImperviousCoverPctFactServeCutover.ts
 * established.
 *
 * The "not record" branch here is not a legacy reader -- maxFootprintSqFt
 * has none. NOT SLATED by this card (fails the gate on every in-scope
 * county, blocked on the 3,376-parcel zoningDistrict residual Z1/P-147
 * owns -- see parcelRecordAllowlist.ts). Every (county, "maxFootprintSqFt")
 * pair therefore resolves to notCutOverMaxFootprintSqFtFact today, by
 * construction, not by omission.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { maxFootprintSqFtFactFromParcelRecord } from "./maxFootprintSqFtFactFromParcelRecord";
import {
  notCutOverMaxFootprintSqFtFact,
  MAX_FOOTPRINT_SQFT_RAIL_KEY,
  type MaxFootprintSqFtFactRead,
} from "./maxFootprintSqFtFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setMaxFootprintSqFtVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetMaxFootprintSqFtVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadMaxFootprintSqFtFactForServe(
  parcelNodeId: string,
): Promise<MaxFootprintSqFtFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverMaxFootprintSqFtFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    MAX_FOOTPRINT_SQFT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverMaxFootprintSqFtFact(parcelNodeId);
  }
  return maxFootprintSqFtFactFromParcelRecord(parcelNodeId);
}
