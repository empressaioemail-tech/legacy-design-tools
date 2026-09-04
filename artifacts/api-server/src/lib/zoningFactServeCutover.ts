/**
 * Serve-layer cutover wrapper for zoning (zoningDistrict + zoningJurisdictionKey
 * + zoningProvenance) (F-01, PARCEL-B-SLATE3, OPS-16 A-096/A-097/A-098), on
 * the allowlist pattern wellFactServeCutover.ts /
 * maxImperviousCoverPctFactServeCutover.ts established.
 *
 * UNLIKE wells/flood/cityLimits, zoning has no LIVE legacy loader to fall
 * back to -- the legacy value is whatever the Tier-1 bake already wrote into
 * facets.zoning, computed offline at bake time, not read here. So this
 * wrapper's contract differs slightly from those precedents': not slated, or
 * slated without a passing gate verdict, resolves to `null` -- "the caller
 * keeps its own bake-derived zoning section, unchanged." Slated WITH a
 * passing gate verdict resolves to the live ZoningFactRead, AS-IS, including
 * its own refused/absent/present state (matching every other cut-over
 * rail's "record is authoritative once gated in" rule -- not a legacy
 * fallback on a record-side refusal, the same choice wellFactServeCutover.ts
 * and cityLimitsFactServeCutover.ts already made).
 *
 * Gated on zoningDistrict's own slate/verdict entry alone (representative of
 * the whole three-key group -- see zoningFactFromParcelRecord.ts's module
 * doc for why jurisdictionKey/provenance are not independently gated: they
 * are metadata about the SAME determination, not independent facts).
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { zoningFactFromParcelRecord } from "./zoningFactFromParcelRecord";
import { ZONING_DISTRICT_RAIL_KEY, type ZoningFactRead } from "./zoningFactFromParcelRecord";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setZoningVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetZoningVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

/**
 * `null` means "not cut over for this parcel -- caller keeps its own
 * bake-derived zoning section unchanged." A non-null result means the
 * (county, zoningDistrict) pair is slated and gate-passing: the record's own
 * ZoningFactRead is authoritative, served as-is.
 */
export async function loadZoningFactForServe(
  parcelNodeId: string,
): Promise<ZoningFactRead | null> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) return null;
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    ZONING_DISTRICT_RAIL_KEY,
  );
  if (state !== "record") return null;
  return zoningFactFromParcelRecord(parcelNodeId);
}
