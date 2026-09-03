/**
 * PARCEL-B-SLATE1 (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for cityLimits, on the pattern
 * wellFactServeCutover.ts (PARCEL-B-READER) established, adapted for
 * cityLimits' different legacy signature (point-based, not parcelNodeId-
 * only) and its own call-order dependency: brokerageNodeFacets.ts's own
 * contract test (cityLimitsFactRoute.contract.test.ts) asserts
 * loadCityLimitsFact runs BEFORE zoningVerdictFromCityLimits BEFORE
 * enrichLandUseFactWithZoningVerdict -- this wrapper is a drop-in
 * replacement at that exact call site, preserving that order (it still
 * resolves and returns before the caller proceeds to the next step).
 *
 * With (county, "cityLimits") absent from PARCEL_RECORD_SLATE, the
 * allowlist check below short-circuits to 'legacy' synchronously, in
 * memory, before any I/O -- loadCityLimitsFact runs exactly as it did
 * before this file existed. The 'record' branch only becomes reachable for
 * a slated, gate-passing pair.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { cityLimitsFactFromParcelRecord } from "./cityLimitsFactFromParcelRecord";
import {
  loadCityLimitsFact,
  type CityLimitsFactWire,
  type CityLimitsQueryPoint,
} from "./cityLimitsFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

const CITY_LIMITS_RAIL_KEY = "cityLimits";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setCityLimitsVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetCityLimitsVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadCityLimitsFactForServe(
  parcelNodeId: string,
  point: CityLimitsQueryPoint | null,
): Promise<CityLimitsFactWire> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    // Malformed parcelNodeId: unchanged behavior, let loadCityLimitsFact's
    // own point-only logic produce its existing unmeasured shape.
    return loadCityLimitsFact(point);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    CITY_LIMITS_RAIL_KEY,
  );
  if (state !== "record") {
    return loadCityLimitsFact(point);
  }
  return cityLimitsFactFromParcelRecord(parcelNodeId, point);
}
