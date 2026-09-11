/**
 * Serve-layer cutover wrapper for maxHeightFt (F-01, OPS-21 P-148 / P-133),
 * on the allowlist pattern maxImperviousCoverPctFactServeCutover.ts
 * established.
 *
 * The "not record" branch here is not a legacy reader -- maxHeightFt has
 * none. NOT SLATED by this card (fails the gate on every in-scope county,
 * blocked on the 3,376-parcel zoningDistrict residual Z1/P-147 owns -- see
 * parcelRecordAllowlist.ts). Every (county, "maxHeightFt") pair therefore
 * resolves to notCutOverMaxHeightFtFact today, by construction, not by
 * omission: this wrapper is safe to merge inert and is what lets a future
 * lane slate this rail in one move once its blocking dependency clears.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { maxHeightFtFactFromParcelRecord } from "./maxHeightFtFactFromParcelRecord";
import {
  notCutOverMaxHeightFtFact,
  MAX_HEIGHT_FT_RAIL_KEY,
  type MaxHeightFtFactRead,
} from "./maxHeightFtFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setMaxHeightFtVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetMaxHeightFtVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadMaxHeightFtFactForServe(
  parcelNodeId: string,
): Promise<MaxHeightFtFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverMaxHeightFtFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    MAX_HEIGHT_FT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverMaxHeightFtFact(parcelNodeId);
  }
  return maxHeightFtFactFromParcelRecord(parcelNodeId);
}
