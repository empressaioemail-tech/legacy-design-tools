/**
 * Serve-layer cutover wrapper for parcelAreaSqFt (F-01, OPS-21 P-148 /
 * P-133), on the allowlist pattern maxImperviousCoverPctFactServeCutover.ts
 * established.
 *
 * The "not record" branch here is not a legacy reader -- parcelAreaSqFt has
 * none. Any (county, "parcelAreaSqFt") pair not in PARCEL_RECORD_SLATE, or
 * lacking a passing gate verdict, resolves to notCutOverParcelAreaSqFtFact.
 *
 * UNLIKE the other 4 rails this dispatch adds, this is the ONE wrapper this
 * card actually slates (48021, 48055, 48309, 48453, 48491 -- all 5 in-scope
 * counties except Hays, live-verified passing at slate time). Building the
 * wrapper is what makes that slate entry non-vacuous, per S4/P-135's own
 * finding that a slate entry with no resolveAllowlist call site is
 * indistinguishable from an inert no-op by every existing test.
 */

import { resolveAllowlist } from "./parcelRecordAllowlist";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { resolveVerdictStore } from "./parcelGateVerdictRead";
import { parcelAreaSqFtFactFromParcelRecord } from "./parcelAreaSqFtFactFromParcelRecord";
import {
  notCutOverParcelAreaSqFtFact,
  PARCEL_AREA_SQFT_RAIL_KEY,
  type ParcelAreaSqFtFactRead,
} from "./parcelAreaSqFtFactRead";
import type { ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * Test/deploy seam for the verdict store this wrapper consults.
 * `undefined` (the default) means: use the real env-resolved pool
 * (resolveVerdictStore, parcelGateVerdictRead.ts). Tests inject an
 * explicit store or `null`.
 */
let injectedVerdictStore: ParcelRecordQueryable | null | undefined;

export function setParcelAreaSqFtVerdictStoreForTests(
  store: ParcelRecordQueryable | null,
): void {
  injectedVerdictStore = store;
}

export function resetParcelAreaSqFtVerdictStoreForTests(): void {
  injectedVerdictStore = undefined;
}

export async function loadParcelAreaSqFtFactForServe(
  parcelNodeId: string,
): Promise<ParcelAreaSqFtFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return notCutOverParcelAreaSqFtFact(parcelNodeId);
  }
  const state = await resolveAllowlist(
    resolveVerdictStore(injectedVerdictStore),
    countyFips,
    PARCEL_AREA_SQFT_RAIL_KEY,
  );
  if (state !== "record") {
    return notCutOverParcelAreaSqFtFact(parcelNodeId);
  }
  return parcelAreaSqFtFactFromParcelRecord(parcelNodeId);
}
