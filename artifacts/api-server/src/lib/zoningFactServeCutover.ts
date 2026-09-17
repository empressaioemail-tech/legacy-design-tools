/**
 * Serve-layer cutover wrapper for zoning (zoningDistrict + zoningJurisdictionKey
 * + zoningProvenance) (F-01, PARCEL-B-SLATE3, OPS-16 A-096/A-097/A-098).
 *
 * UNLIKE wells/flood/cityLimits, zoning has no LIVE legacy loader to fall back
 * to: the legacy value is whatever the Tier-1 bake already wrote into
 * facets.zoning, computed offline at bake time, not read here. So the
 * not-served-from-the-ledger answer is `null`, meaning "the caller keeps its
 * own bake-derived zoning section, unchanged".
 *
 * Gated on zoningDistrict's own slate entry alone (representative of the whole
 * three-key group: jurisdictionKey/provenance are metadata about the SAME
 * determination, not independent facts).
 *
 * P-297 (2026-09-16, operator ruling A-193) replaced the county-verdict
 * gate this file used to apply. Until P-297 the wrapper asked
 * `resolveAllowlist` for (record | legacy | refused) and served the record's
 * own answer only on `record`, which required a PASSING county gate verdict
 * -- so a slated county whose verdict read `refuse` (one unaccounted cell on
 * this rail, anywhere in the county) fell back for EVERY parcel in it,
 * including parcels whose own cell was earned and correct. The verdict is a
 * completeness and publish grade; it stopped deciding what a parcel shows.
 *
 * The wrapper now decides from PARCEL_RECORD_SLATE and the PARCEL'S OWN CELL
 * through the one rule in `cellServeRule.ts`:
 *
 *   - pair NOT in the slate -> the fallback below, short-circuiting before any
 *     I/O, byte-identical to the behavior before this file existed. The slate,
 *     not the verdict, is the cut-over switch.
 *   - pair in the slate -> this parcel's own cell, served through the record
 *     adapter AS-IS: a value with its source and vintage, a stated absence
 *     with its reason, or a declared refusal carrying the cell's own reason
 *     (unaccounted, engine-refused, cell-miss, malformed-cell,
 *     store-not-configured). Never the legacy or baked value.
 *
 * The county verdict is no longer read on this path; `cellServeRule.test.ts`
 * fails if this file imports the verdict reader again.
 */

import { loadCellServeDecision } from "./cellServeRule";
import { parseParcelNodeId } from "./parcelNodeId";
import { zoningFactFromParcelRecord, ZONING_DISTRICT_RAIL_KEY, type ZoningFactRead } from "./zoningFactFromParcelRecord";

export async function loadZoningFactForServe(
  parcelNodeId: string,
): Promise<ZoningFactRead | null> {
  const parsed = parseParcelNodeId(parcelNodeId);
  if (!parsed) return null;
  const decision = await loadCellServeDecision(
    parsed.countyFips,
    parsed.propId,
    ZONING_DISTRICT_RAIL_KEY,
  );
  if (decision.serve === "current-path") return null;
  return zoningFactFromParcelRecord(parcelNodeId);
}
