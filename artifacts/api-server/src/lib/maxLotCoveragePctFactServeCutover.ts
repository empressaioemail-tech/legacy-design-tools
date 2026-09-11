/**
 * Serve-layer cutover wrapper for maxLotCoveragePct (F-01, OPS-21 P-148 /
 * P-133), on the allowlist pattern maxImperviousCoverPctFactServeCutover.ts
 * established.
 *
 * The "not record" branch here is not a legacy reader -- maxLotCoveragePct
 * has none. NOT SLATED by this card (fails the gate on every in-scope
 * county, blocked on the 3,376-parcel zoningDistrict residual Z1/P-147
 * owns -- see parcelRecordAllowlist.ts). Every (county, "maxLotCoveragePct")
 * pair therefore resolves to notCutOverMaxLotCoveragePctFact today, by
 * construction, not by omission.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { maxLotCoveragePctFactFromParcelRecord } from "./maxLotCoveragePctFactFromParcelRecord";
import {
  notCutOverMaxLotCoveragePctFact,
  MAX_LOT_COVERAGE_PCT_RAIL_KEY,
  type MaxLotCoveragePctFactRead,
} from "./maxLotCoveragePctFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setMaxLotCoveragePctVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetMaxLotCoveragePctVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadMaxLotCoveragePctFactForServe(
  parcelNodeId: string,
): Promise<MaxLotCoveragePctFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverMaxLotCoveragePctFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    MAX_LOT_COVERAGE_PCT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverMaxLotCoveragePctFact(parcelNodeId);
  }
  return maxLotCoveragePctFactFromParcelRecord(parcelNodeId);
}
