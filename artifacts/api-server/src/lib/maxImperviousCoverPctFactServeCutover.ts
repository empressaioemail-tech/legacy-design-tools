/**
 * Serve-layer cutover wrapper for maxImperviousCoverPct (F-01, serve/prod
 * cutover for ACQUIRE-GIS wave 1 + PARCEL wave 2,
 * `_decisions/2026-09-02_step7_consumer_c_then_b.md`), on the allowlist
 * pattern wellFactServeCutover.ts (PARCEL-B-READER/PARCEL-B-SLATE1)
 * established.
 *
 * UNLIKE that precedent, the "not record" branch here is not a legacy
 * reader -- maxImperviousCoverPct has none. Any (county,
 * "maxImperviousCoverPct") pair not in PARCEL_RECORD_SLATE (which is only
 * Travis 48453; see maxImperviousCoverPctFactRead.ts's module doc), or
 * lacking a passing gate verdict, resolves to
 * `notCutOverMaxImperviousCoverPctFact`.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { maxImperviousCoverPctFactFromParcelRecord } from "./maxImperviousCoverPctFactFromParcelRecord";
import {
  notCutOverMaxImperviousCoverPctFact,
  MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY,
  type MaxImperviousCoverPctFactRead,
} from "./maxImperviousCoverPctFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setMaxImperviousCoverPctVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetMaxImperviousCoverPctVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadMaxImperviousCoverPctFactForServe(
  parcelNodeId: string,
): Promise<MaxImperviousCoverPctFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverMaxImperviousCoverPctFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    MAX_IMPERVIOUS_COVER_PCT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverMaxImperviousCoverPctFact(parcelNodeId);
  }
  return maxImperviousCoverPctFactFromParcelRecord(parcelNodeId);
}
