/**
 * Async structural/CAMA loader for inspect — delegates pure resolution to
 * {@link structuralFactResolve}.
 */

import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import { db } from "@workspace/db";
import {
  buildStructuralLookupFailedAbsence,
  countyFipsFromParcelNodeId,
  isStructuralCamaLookupFailed,
} from "./verdictLayerServe";
import { makeCadPropertyLookup } from "./cadPropertyLookup";
import {
  resolveStructuralFactRead,
  structuralFactAbsentVerified,
  STRUCTURAL_FACT_SOURCE,
  type StructuralFactRead,
} from "./structuralFactResolve";

export type {
  StructuralFactAbsent,
  StructuralFactPresent,
  StructuralFactRead,
} from "./structuralFactResolve";
export { resolveStructuralFactRead, STRUCTURAL_FACT_SOURCE } from "./structuralFactResolve";

function propIdFromParcelNodeId(parcelNodeId: string): string | null {
  const idx = parcelNodeId.indexOf(":");
  if (idx < 0) return null;
  const propId = parcelNodeId.slice(idx + 1).trim();
  return propId || null;
}

export async function loadStructuralFactAtom(
  parcelNodeId: string,
): Promise<StructuralFactRead> {
  const countyFips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!countyFips) {
    return structuralFactAbsentVerified(
      "unknown",
      "parcel node id",
      "malformed parcelNodeId",
    );
  }
  if (isStructuralCamaLookupFailed(countyFips)) {
    return {
      ...buildStructuralLookupFailedAbsence(countyFips),
      source: STRUCTURAL_FACT_SOURCE,
    };
  }
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) {
    return structuralFactAbsentVerified(
      countyFips,
      "parcel node id",
      "malformed parcelNodeId",
    );
  }
  const declared = tryResolveDeclaredCadVintage(countyFips);
  if (!declared) {
    return structuralFactAbsentVerified(
      countyFips,
      "cad_property declared vintage",
      `No declared current_tax_year/current_tier for county ${countyFips}`,
    );
  }
  const cadLookup = makeCadPropertyLookup(db);
  const row = await cadLookup(countyFips, propId);
  if (!row) {
    return resolveStructuralFactRead({
      parcelNodeId,
      lookupFailed: false,
      cadRow: null,
    });
  }
  return resolveStructuralFactRead({
    parcelNodeId,
    lookupFailed: false,
    cadRow: {
      taxYear: declared.taxYear,
      tier: declared.tier,
      livingAreaSqft: row.livingAreaSqft ?? null,
      yearBuilt: row.yearBuilt ?? null,
      sourceVintage: row.sourceVintage ?? null,
    },
  });
}
