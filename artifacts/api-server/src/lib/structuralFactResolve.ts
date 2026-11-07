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
import {
  isParcelRecordRefusal,
  type CadRollParcelRecordRefusal,
  type LivingAreaSqftFromParcelRecord,
  type YearBuiltFromParcelRecord,
} from "./cadRollFactFromParcelRecord";

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
 * P-269/P-297 (operator ruling A-193): `overlay` is only non-null when that
 * rail is in the slate, and a DECLARED REFUSAL from the store is now served
 * as a declared refusal of the whole structural read -- a `verdict:
 * "refused"` LayerAbsenceWire, naming the rail and carrying the cell's own
 * reason -- instead of being passed off as "no overlay, keep the legacy
 * value". A structural present object cannot express "this one field is
 * refused" (its fields are `number | null`, and `null` there means an
 * absence), so the honest shape is the object-level refusal the layer wire
 * already provides. Being spuriously `present` with one baked field is the
 * alternative, and it is exactly what the ruling forbids.
 *
 * Disclosed limitation (unchanged from before this card): if the legacy read
 * is itself `state: "absent"` (no cad_property row, or lookup failed) while a
 * rail has a real parcel_record value, this function does NOT synthesize a
 * new "present" object -- doing so would require fabricating taxYear/tier
 * fields parcel_record does not carry. It returns the legacy absence
 * unchanged in that case. Named explicitly in this card's own close rather
 * than silently accepted; the common case (a present legacy row with one
 * field overlaid) is fully handled.
 */
export function structuralFactWithParcelRecordOverlay(
  fact: StructuralFactRead,
  overlay: {
    livingAreaSqft: LivingAreaSqftFromParcelRecord;
    yearBuilt: YearBuiltFromParcelRecord;
  },
): StructuralFactRead {
  const livingRefusal = isParcelRecordRefusal(overlay.livingAreaSqft)
    ? overlay.livingAreaSqft
    : null;
  const yearRefusal = isParcelRecordRefusal(overlay.yearBuilt) ? overlay.yearBuilt : null;
  const refusal = livingRefusal ?? yearRefusal;
  if (refusal) {
    const rails = [
      livingRefusal ? "livingAreaSqft" : null,
      yearRefusal ? "yearBuilt" : null,
    ].filter((rail): rail is string => rail != null);
    return structuralFactRefusedFromParcelRecord(refusal, rails);
  }
  if (!fact || typeof fact !== "object" || !("state" in fact) || fact.state !== "present") {
    return fact;
  }
  const next: StructuralFactPresent = { ...fact };
  const living = overlay.livingAreaSqft;
  if (living && !isParcelRecordRefusal(living)) {
    next.livingAreaSqft = living.status === "populated" ? living.value : null;
  }
  const year = overlay.yearBuilt;
  if (year && !isParcelRecordRefusal(year)) {
    next.yearBuilt = year.v;
  }
  return next;
}

/**
 * The declared-refusal structural read P-269 serves instead of a baked value
 * on a slated rail. Same shape family as every other refusal on this serve
 * path: a LayerAbsenceWire with `verdict: "refused"`, so
 * `structuralFactToLivingAreaWire` below needs no new branch and the
 * customer gets the store's own reason instead of a number nobody stands
 * behind.
 */
export function structuralFactRefusedFromParcelRecord(
  refusal: CadRollParcelRecordRefusal,
  railKeys: ReadonlyArray<string>,
  asOf: string = new Date().toISOString(),
): StructuralFactAbsent {
  const classification = absenceClassificationForEntityType("cad-parcel-roll");
  const rails = railKeys.length > 0 ? railKeys.join(",") : "cadRoll";
  return {
    status: "absent",
    verdict: "refused",
    authority: "parcel_record",
    scopeSearched: `parcel_record_cell@${rails}`,
    asOf,
    basis: `${refusal.reason} (parcel_record refused the ${rails} cell: ${refusal.code}.)`,
    ...classification,
    entityType: "cad_property",
    provenanceClass: classification.provenanceClass ?? "Record",
    source: STRUCTURAL_FACT_SOURCE,
  };
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
