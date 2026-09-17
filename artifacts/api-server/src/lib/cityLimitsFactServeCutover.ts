/**
 * PARCEL-B-SLATE1 (F-01, `_decisions/2026-09-02_step7_consumer_c_then_b.md`)
 * serve-layer cutover wrapper for cityLimits, adapted for cityLimits'
 * different legacy signature (point-based, not parcelNodeId-only) and its own
 * call-order dependency: brokerageNodeFacets.ts's own contract test
 * (cityLimitsFactRoute.contract.test.ts) asserts loadCityLimitsFact runs
 * BEFORE zoningVerdictFromCityLimits BEFORE enrichLandUseFactWithZoningVerdict
 * -- this wrapper is a drop-in replacement at that exact call site,
 * preserving that order (it still resolves and returns before the caller
 * proceeds to the next step).
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict gate
 * this file used to apply. The wrapper now decides from PARCEL_RECORD_SLATE
 * and the parcel's own cell through the one rule in `cellServeRule.ts`:
 * an unslated (county, "cityLimits") pair runs `loadCityLimitsFact` exactly
 * as it did before this file existed, short-circuiting before any I/O; a
 * slated pair serves this parcel's own cell through the record adapter,
 * including the adapter's own typed refusal. A slated county with a `refuse`
 * gate verdict no longer drags every parcel back to the legacy read.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { cityLimitsFactFromParcelRecord } from "./cityLimitsFactFromParcelRecord";
import {
  loadCityLimitsFact,
  type CityLimitsFactWire,
  type CityLimitsQueryPoint,
} from "./cityLimitsFactRead";

const CITY_LIMITS_RAIL_KEY = "cityLimits";

export async function loadCityLimitsFactForServe(
  parcelNodeId: string,
  point: CityLimitsQueryPoint | null,
): Promise<CityLimitsFactWire> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) {
    // Malformed parcelNodeId: unchanged behavior, let loadCityLimitsFact's
    // own point-only logic produce its existing unmeasured shape.
    return loadCityLimitsFact(point);
  }
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    CITY_LIMITS_RAIL_KEY,
  );
  if (decision.serve === "current-path") {
    return loadCityLimitsFact(point);
  }
  return cityLimitsFactFromParcelRecord(parcelNodeId, point);
}
