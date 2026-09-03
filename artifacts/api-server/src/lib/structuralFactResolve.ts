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

/**
 * PARCEL-B-SLATE2: propertyExplorer.ts's research/brief endpoint serves
 * livingAreaSqft and yearBuilt bundled in one StructuralFactRead object (no
 * baked-snapshot overlay slot the way brokerageNodeFacets.ts has). Cutting
 * either field over independently means merging a parcel_record-sourced
 * value into the legacy object's OTHER fields (taxYear, tier, sourceVintage,
 * entityType), never a whole-object swap.
 *
 * Disclosed limitation: if the legacy read is itself `state: "absent"` (no
 * cad_property row, or lookup failed) while a rail resolves to "record"
 * with a real parcel_record value, this function does NOT synthesize a new
 * "present" object -- doing so would require fabricating taxYear/tier
 * fields parcel_record does not carry. It returns the legacy absence
 * unchanged in that case. Named explicitly in this card's own close rather
 * than silently accepted; the common case (a present legacy row with one
 * field overlaid) is fully handled.
 */
export function structuralFactWithParcelRecordOverlay(
  fact: StructuralFactRead,
  overlay: {
    livingAreaSqft: { status: "populated"; value: number } | { status: "absent-in-record" } | null;
    yearBuilt: { v: number; source: string; vintage: string | null } | null;
  },
): StructuralFactRead {
  if (!fact || typeof fact !== "object" || !("state" in fact) || fact.state !== "present") {
    return fact;
  }
  const next: StructuralFactPresent = { ...fact };
  if (overlay.livingAreaSqft) {
    next.livingAreaSqft =
      overlay.livingAreaSqft.status === "populated" ? overlay.livingAreaSqft.value : null;
  }
  if (overlay.yearBuilt) {
    next.yearBuilt = overlay.yearBuilt.v;
  }
  return next;
}

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
