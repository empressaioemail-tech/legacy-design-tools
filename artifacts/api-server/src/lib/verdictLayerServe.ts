/**
 * Doc 19 §Layer absence verdicts on property inspect (P-63).
 *
 * Vocabulary matches Smart Files absence enum plus `not-applicable`.
 * Serve path never upgrades `lookup-failed` → `absent-verified`.
 */

import { absenceClassificationForEntityType } from "@workspace/instrument-registry";
import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import { NO_ZONING_STAMP_REASON } from "./buildableEnvelope/absentZoningHonesty";
import texasCountyRoster from "../../data/texas_county_roster_v1.json";

type CadSourceTier = "cad-export" | "stratmap-roll";

export const LAYER_ABSENCE_VERDICTS = [
  "absent-verified",
  "lookup-failed",
  "not-applicable",
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
 * Shape predicate: parcel baked without a zoning stamp in a county whose
 * unincorporated territory has no municipal zoning authority.
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

/** Parcel-level unincorporated: no zoning stamp and no incorporated situs city. */
export function parcelIsUnincorporatedShape(facets: unknown): boolean {
  if (!parcelShapeLacksZoningAuthority(facets)) return false;
  const root = facets as Record<string, unknown>;
  const baseFacts = root.baseFacts;
  if (baseFacts && typeof baseFacts === "object" && !Array.isArray(baseFacts)) {
    const situsCity = (baseFacts as Record<string, unknown>).situsCity;
    if (typeof situsCity === "string" && situsCity.trim()) return false;
  }
  return true;
}

export function isUnincorporatedNoZoningAuthorityShape(
  parcelNodeId: string,
  bakedFacets: unknown,
): boolean {
  const fips = countyFipsFromParcelNodeId(parcelNodeId);
  if (!fips || !countyHasUnzonedUnincorporatedDoctrine(fips)) return false;
  return parcelIsUnincorporatedShape(bakedFacets);
}

export function buildZoningNotApplicableAbsence(
  asOf: string = new Date().toISOString(),
): LayerAbsenceWire {
  const classification = absenceClassificationForEntityType("zoning-fact");
  return {
    status: "absent",
    verdict: "not-applicable",
    authority: "none",
    scopeSearched: "municipal zoning authority for parcel shape=unincorporated",
    asOf,
    basis: "shape predicate: no zoning authority exists for unincorporated land",
    ...classification,
    entityType: "zoning-fact",
    provenanceClass: classification.provenanceClass ?? "Record",
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
