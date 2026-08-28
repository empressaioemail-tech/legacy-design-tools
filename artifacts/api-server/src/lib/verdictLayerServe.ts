/**
 * Doc 19 §Layer absence verdicts on property inspect (P-63).
 *
 * Vocabulary matches Smart Files absence enum plus `not-applicable`.
 * Serve path never upgrades `lookup-failed` → `absent-verified`.
 */

import { absenceClassificationForEntityType } from "@workspace/instrument-registry";
import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import { NO_ZONING_STAMP_REASON } from "./buildableEnvelope/absentZoningHonesty";
import type {
  CityLimitsFact,
  CityLimitsStatus,
} from "@workspace/cad-ingest/city-limits";
import texasCountyRoster from "../../data/texas_county_roster_v1.json";

type CadSourceTier = "cad-export" | "stratmap-roll";

export const LAYER_ABSENCE_VERDICTS = [
  "absent-verified",
  "lookup-failed",
  "not-applicable",
  /**
   * CTX card F (2026-08-28): the parcel sits inside an incorporated place and
   * carries no zoning stamp. The stamp is missing; authority is not absent.
   */
  "stamp-missing",
  /**
   * CTX card F: whether municipal zoning authority applies could not be
   * measured (no usable query point, empty city-limits index, or a county with
   * no declared unincorporated doctrine). Never collapsed into not-applicable.
   */
  "unmeasured",
] as const;

export type LayerAbsenceVerdict = (typeof LAYER_ABSENCE_VERDICTS)[number];

export type LayerProvenanceClass = "Record" | "Observation" | "Derivation" | "Synthesis";
export type LayerSubjectKind = "extensional" | "intensional";
export type LayerChainAnchoring = "contemporaneous" | "backfill";

/** Wire shape for a non-populated layer per doc 19 §Layer. */
export interface LayerAbsenceWire {
  status: "absent";
  verdict: LayerAbsenceVerdict;
  authority: string;
  scopeSearched: string;
  asOf: string;
  basis: string;
  provenanceClass: LayerProvenanceClass;
  subjectKind: LayerSubjectKind;
  chainAnchoring: LayerChainAnchoring;
  serveLayer: string;
  entityType?: string;
  /** Present on zoning verdicts derived from city-limits containment (card F). */
  derivation?: ZoningVerdictDerivation;
}

/** Counties with bulk_primary=true in tx_cad_source_registry.json (2026-08-22). */
export const BULK_PRIMARY_COUNTY_FIPS = new Set(["48113", "48439"]);

const COUNTY_APPRAISAL_AUTHORITY: Readonly<Record<string, string>> = {
  "48113": "dcad",
  "48439": "tad",
};

type RosterCounty = {
  record_type?: string;
  fips?: string;
  zoning_regime?: { unincorporated?: string };
};

const UNZONED_UNINCORPORATED_FIPS = new Set(
  (texasCountyRoster as { counties?: RosterCounty[] }).counties
    ?.filter(
      (c) =>
        c.record_type === "county" &&
        c.zoning_regime?.unincorporated === "unzoned" &&
        typeof c.fips === "string",
    )
    .map((c) => c.fips as string) ?? [],
);

export function countyFipsFromParcelNodeId(parcelNodeId: string): string | null {
  const match = /^(\d{5}):/.exec(parcelNodeId.trim());
  return match ? match[1] : null;
}

/**
 * Registry bulk_primary county on declared stratmap-roll tier: structural/CAMA
 * fields cannot be read from the roll — lookup failed, not absent-verified.
 */
export function isStructuralCamaLookupFailedForDeclaredTier(
  countyFips: string,
  tier: CadSourceTier | null | undefined,
): boolean {
  const fips = countyFips.trim();
  if (!BULK_PRIMARY_COUNTY_FIPS.has(fips)) return false;
  return tier === "stratmap-roll";
}

export function isStructuralCamaLookupFailed(countyFips: string): boolean {
  const vintage = tryResolveDeclaredCadVintage(countyFips);
  return isStructuralCamaLookupFailedForDeclaredTier(
    countyFips,
    vintage?.tier ?? null,
  );
}

export function structuralLookupFailedAuthority(countyFips: string): string {
  return COUNTY_APPRAISAL_AUTHORITY[countyFips.trim()] ?? "county-appraisal-district";
}

export function buildStructuralLookupFailedAbsence(
  countyFips: string,
  asOf: string = new Date().toISOString(),
  /** Caller must pass stratmap-roll — this builder runs only on that branch. */
  tier: CadSourceTier = "stratmap-roll",
): LayerAbsenceWire {
  const authority = structuralLookupFailedAuthority(countyFips);
  const classification = absenceClassificationForEntityType("cad-parcel-roll");
  return {
    status: "absent",
    verdict: "lookup-failed",
    authority,
    scopeSearched: `cad_property ${tier} tier; CAMA bulk export not loaded`,
    asOf,
    basis:
      `registry bulk_primary=true; declared vintage tier=${tier}; ` +
      "CAMA bulk export undeclared",
    ...classification,
    entityType: "cad-parcel-roll",
    provenanceClass: classification.provenanceClass ?? "Record",
  };
}

/**
 * P-77: map node exists but no cad_property row at declared vintage (join miss).
 * Not absent-verified — we did not verify absence of a parcel record globally.
 */
export function buildCadPropertyJoinMissLookupFailed(
  countyFips: string,
  parcelNodeId: string,
  taxYear: number | undefined,
  tier: string,
  asOf: string = new Date().toISOString(),
): LayerAbsenceWire {
  const authority = structuralLookupFailedAuthority(countyFips);
  const classification = absenceClassificationForEntityType("cad-parcel-roll");
  const vintageLabel = `${taxYear ?? "unknown"}/${tier}`;
  return {
    status: "absent",
    verdict: "lookup-failed",
    authority,
    scopeSearched: `cad_property declared vintage ${vintageLabel}`,
    asOf,
    basis: `No cad_property row at declared vintage for ${parcelNodeId}`,
    ...classification,
    entityType: "cad-parcel-roll",
    provenanceClass: classification.provenanceClass ?? "Record",
  };
}

export function countyHasUnzonedUnincorporatedDoctrine(countyFips: string): boolean {
  return UNZONED_UNINCORPORATED_FIPS.has(countyFips.trim());
}

/**
 * Stamp predicate: the baked parcel carries NO zoning stamp (no district, no
 * jurisdictionKey, envelope declined for no-zoning-stamp, or coverage false).
 * This says nothing about incorporation; it only says the stamp is absent.
 */
export function parcelShapeLacksZoningAuthority(facets: unknown): boolean {
  if (!facets || typeof facets !== "object") return false;
  const root = facets as Record<string, unknown>;
  const zoning = root.zoning;
  if (zoning && typeof zoning === "object" && !Array.isArray(zoning)) {
    const district = (zoning as Record<string, unknown>).district;
    if (typeof district === "string" && district.trim()) return false;
    const jurisdictionKey = (zoning as Record<string, unknown>).jurisdictionKey;
    if (typeof jurisdictionKey === "string" && jurisdictionKey.trim()) {
      return false;
    }
  }
  const envelope = root.envelope;
  if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
    if (
      (envelope as Record<string, unknown>).declineReason ===
      NO_ZONING_STAMP_REASON
    ) {
      return true;
    }
  }
  const coverage = root.facetCoverage;
  if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
    if ((coverage as Record<string, unknown>).zoning === false) return true;
  }
  return false;
}

/**
 * CTX card F (2026-08-28): unincorporated is a finding about a boundary,
 * never about a null.
 *
 * Until this card the serve decided "unincorporated" from a null
 * baseFacts.situsCity (parcelIsUnincorporatedShape, removed). The conformant
 * bake wrote that field null for every parcel in the six Central Texas
 * counties (1,498,010 rows measured 2026-08-28 19:48Z), so a parcel in
 * central Austin was served "not-applicable: no zoning authority exists for
 * unincorporated land". Incorporation is now the city-limits containment fact
 * and nothing else: loadCityLimitsFact (PIP against tx_city_boundary at the
 * bake query point) returns incorporated with the place, unincorporated only
 * when the index is populated and the point sits outside every polygon, or
 * unmeasured (empty index or no usable point). A postal, mailing, or situs
 * city is never an input here.
 */
export type CityLimitsContainment = CityLimitsFact & {
  /** The WGS84 point the containment was evaluated at; null when unmeasured for lack of one. */
  queryPoint: { longitude: number; latitude: number } | null;
};

/**
 * True only when the parcel carries no zoning stamp, the county's
 * unincorporated territory is unzoned (texas_county_roster_v1), AND the
 * city-limits index is populated with the parcel point outside every
 * incorporated place. Anything else is false: an incorporated place, an
 * unmeasured index, a missing point, or a county with no declared doctrine.
 */
export function isUnincorporatedNoZoningAuthorityShape(
  parcelNodeId: string,
  bakedFacets: unknown,
  cityLimits: Pick<CityLimitsContainment, "status"> | null | undefined,
): boolean {
  const fips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!fips || !countyHasUnzonedUnincorporatedDoctrine(fips)) return false;
  if (!parcelShapeLacksZoningAuthority(bakedFacets)) return false;
  return cityLimits?.status === "unincorporated";
}

/** How a zoning verdict was derived: the containment fact it rests on. */
export interface ZoningVerdictDerivation {
  method: "city-limits-containment";
  source: "tx_city_boundary";
  cityLimitsStatus: CityLimitsStatus;
  queryPoint: { longitude: number; latitude: number } | null;
  place: { cityName: string; geoId: string; gnis: string | null } | null;
  countyDoctrine: "unzoned-unincorporated" | "undeclared";
}

function pointText(qp: { longitude: number; latitude: number } | null): string {
  return qp
    ? `query point lng ${qp.longitude} lat ${qp.latitude}`
    : "no usable query point";
}

/**
 * The served zoning layer for a parcel WITHOUT a zoning stamp, derived from
 * the city-limits containment fact. Null when the parcel carries a stamp
 * (the stamp is served as-is). Three states, never collapsed:
 *
 *   incorporated   -> stamp-missing: the parcel sits inside a named place and
 *                     the stamp is missing; zoning authority is NOT absent.
 *   unincorporated -> not-applicable when the county's unincorporated
 *                     territory is unzoned (texas_county_roster_v1), with the
 *                     city-limits basis and source named; unmeasured when the
 *                     county declares no doctrine (not-applicable is never
 *                     asserted from silence).
 *   unmeasured     -> unmeasured, carrying the reason the index gave (empty
 *                     table or no usable query point).
 *
 * The returned wire carries derivation so a reader can see the point and the
 * containment status the verdict rests on.
 */
export function zoningVerdictFromCityLimits(
  parcelNodeId: string,
  bakedFacets: unknown,
  cityLimits: CityLimitsContainment,
  asOf: string = new Date().toISOString(),
): LayerAbsenceWire | null {
  if (!parcelShapeLacksZoningAuthority(bakedFacets)) return null;
  const fips = countyFipsFromParcelNodeId(parcelNodeId);
  const countyDoctrine: ZoningVerdictDerivation["countyDoctrine"] =
    fips && countyHasUnzonedUnincorporatedDoctrine(fips)
      ? "unzoned-unincorporated"
      : "undeclared";
  const classification = absenceClassificationForEntityType("zoning-fact");
  const queryPoint = cityLimits.queryPoint ?? null;
  const place =
    cityLimits.status === "incorporated" && cityLimits.cityName && cityLimits.geoId
      ? {
          cityName: cityLimits.cityName,
          geoId: cityLimits.geoId,
          gnis: cityLimits.gnis ?? null,
        }
      : null;
  const derivation: ZoningVerdictDerivation = {
    method: "city-limits-containment",
    source: "tx_city_boundary",
    cityLimitsStatus: cityLimits.status,
    queryPoint,
    place,
    countyDoctrine,
  };
  const common = {
    status: "absent" as const,
    asOf,
    ...classification,
    entityType: "zoning-fact",
    provenanceClass: classification.provenanceClass ?? ("Record" as const),
    derivation,
  };
  const countyLabel = fips ?? "unknown";

  if (cityLimits.status === "incorporated") {
    const cityName = place?.cityName ?? cityLimits.cityName ?? "incorporated place";
    const geoId = place?.geoId ?? cityLimits.geoId ?? "unknown";
    return {
      ...common,
      verdict: "stamp-missing",
      authority: cityName,
      scopeSearched:
        `municipal zoning stamp for ${cityName} (tx_city_boundary geo_id=${geoId}) ` +
        `on parcel ${parcelNodeId}; ${pointText(queryPoint)}`,
      basis:
        `${cityLimits.basis}; the parcel sits inside the incorporated place ${cityName} ` +
        "and carries no zoning stamp, so the stamp is missing; zoning authority is not absent",
    };
  }

  if (cityLimits.status === "unincorporated") {
    const scopeSearched =
      `incorporated-place polygons in tx_city_boundary at the parcel ${pointText(queryPoint)}; ` +
      `texas_county_roster_v1 zoning_regime.unincorporated for county ${countyLabel}`;
    if (countyDoctrine === "unzoned-unincorporated") {
      return {
        ...common,
        verdict: "not-applicable",
        authority: "none",
        scopeSearched,
        basis:
          `${cityLimits.basis}; county ${countyLabel} unincorporated territory is unzoned ` +
          "(texas_county_roster_v1), so no municipal zoning authority applies",
      };
    }
    return {
      ...common,
      verdict: "unmeasured",
      authority: "unresolved",
      scopeSearched,
      basis:
        `${cityLimits.basis}; county ${countyLabel} does not declare ` +
        "zoning_regime.unincorporated=unzoned in texas_county_roster_v1, so whether " +
        "zoning authority applies is unmeasured",
    };
  }

  return {
    ...common,
    verdict: "unmeasured",
    authority: "unresolved",
    scopeSearched: `incorporated-place polygons in tx_city_boundary; ${pointText(queryPoint)}`,
    basis: cityLimits.basis,
  };
}

/** Gate rule: upstream lookup-failed must never become absent-verified in transit. */
export function assertNoVerdictUpgrade(
  prior: LayerAbsenceVerdict | null | undefined,
  next: LayerAbsenceVerdict,
): void {
  if (prior === "lookup-failed" && next === "absent-verified") {
    throw new Error(
      "verdict upgrade forbidden: lookup-failed cannot become absent-verified in transit",
    );
  }
}

export function mergeLayerVerdict<T extends Record<string, unknown>>(
  target: T,
  absence: LayerAbsenceWire,
  opts?: { priorVerdict?: LayerAbsenceVerdict | null },
): T & LayerAbsenceWire {
  if (opts?.priorVerdict) {
    assertNoVerdictUpgrade(opts.priorVerdict, absence.verdict);
  }
  return { ...target, ...absence };
}
