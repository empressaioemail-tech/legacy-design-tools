/**
 * Pure structural fact resolution (db-free) for tests and the async loader.
 */

import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import {
  BULK_PRIMARY_COUNTY_FIPS,
  buildCadPropertyJoinMissLookupFailed,
  buildStructuralLookupFailedAbsence,
  countyFipsFromParcelNodeId,
  type LayerAbsenceWire,
} from "./verdictLayerServe";
import { absenceClassificationForEntityType } from "@workspace/instrument-registry";
import { normalizeCadPropId } from "./parcelNodeId";

export const STRUCTURAL_FACT_SOURCE = "structural-fact" as const;

export type StructuralFactPresent = {
  state: "present";
  source: typeof STRUCTURAL_FACT_SOURCE;
  entityType: "cad_property";
  countyFips: string;
  propId: string;
  taxYear: number;
  tier: string;
  livingAreaSqft: number | null;
  yearBuilt: number | null;
  sourceVintage: string | null;
};

export type StructuralFactAbsent = LayerAbsenceWire & {
  source: typeof STRUCTURAL_FACT_SOURCE;
};

export type StructuralFactRead = StructuralFactPresent | StructuralFactAbsent;

function propIdFromParcelNodeId(parcelNodeId: string): string | null {
  const idx = parcelNodeId.indexOf(":");
  if (idx < 0) return null;
  const propId = parcelNodeId.slice(idx + 1).trim();
  return propId || null;
}

export function structuralFactAbsentVerified(
  countyFips: string,
  scopeSearched: string,
  basis: string,
  asOf: string = new Date().toISOString(),
): StructuralFactAbsent {
  const authority =
    countyFips === "48439"
      ? "tad"
      : countyFips === "48113"
        ? "dcad"
        : "county-appraisal-district";
  const classification = absenceClassificationForEntityType("cad-parcel-roll");
  return {
    status: "absent",
    verdict: "absent-verified",
    authority,
    scopeSearched,
    asOf,
    basis,
    ...classification,
    entityType: "cad_property",
    provenanceClass: classification.provenanceClass ?? "Record",
    source: STRUCTURAL_FACT_SOURCE,
  };
}

export function resolveStructuralFactRead(opts: {
  parcelNodeId: string;
  lookupFailed: boolean;
  cadRow: {
    taxYear: number;
    tier: string;
    livingAreaSqft: number | null;
    yearBuilt: number | null;
    sourceVintage: string | null;
  } | null;
  asOf?: string;
}): StructuralFactRead {
  const countyFips = countyFipsFromParcelNodeId(opts.parcelNodeId);
  const propId = propIdFromParcelNodeId(opts.parcelNodeId);
  if (!countyFips || !propId) {
    return structuralFactAbsentVerified(
      countyFips ?? "unknown",
      "parcel node id",
      "malformed parcelNodeId",
      opts.asOf,
    );
  }
  if (opts.lookupFailed) {
    return {
      ...buildStructuralLookupFailedAbsence(countyFips, opts.asOf),
      source: STRUCTURAL_FACT_SOURCE,
    };
  }
  if (!opts.cadRow) {
    const vintage = tryResolveDeclaredCadVintage(countyFips);
    const tier = vintage?.tier ?? "undeclared";
    const year = vintage?.taxYear;
    return {
      ...buildCadPropertyJoinMissLookupFailed(
        countyFips,
        opts.parcelNodeId,
        year,
        tier,
        opts.asOf,
      ),
      source: STRUCTURAL_FACT_SOURCE,
    };
  }
  if (
    opts.cadRow.livingAreaSqft == null &&
    opts.cadRow.yearBuilt == null
  ) {
    if (BULK_PRIMARY_COUNTY_FIPS.has(countyFips)) {
      const tier =
        opts.cadRow.tier === "cad-export" || opts.cadRow.tier === "stratmap-roll"
          ? opts.cadRow.tier
          : "stratmap-roll";
      return {
        ...buildStructuralLookupFailedAbsence(countyFips, opts.asOf, tier),
        source: STRUCTURAL_FACT_SOURCE,
      };
    }
    return structuralFactAbsentVerified(
      countyFips,
      `cad_property tax_year=${opts.cadRow.taxYear} tier=${opts.cadRow.tier}`,
      "CAD row present but structural fields (living_area_sqft, year_built) are null",
      opts.asOf,
    );
  }
  const classification = absenceClassificationForEntityType("cad-parcel-roll");
  return {
    state: "present",
    source: STRUCTURAL_FACT_SOURCE,
    ...classification,
    entityType: "cad_property",
    countyFips,
    propId: normalizeCadPropId(propId),
    taxYear: opts.cadRow.taxYear,
    tier: opts.cadRow.tier,
    livingAreaSqft: opts.cadRow.livingAreaSqft,
    yearBuilt: opts.cadRow.yearBuilt,
    sourceVintage: opts.cadRow.sourceVintage,
  };
}
