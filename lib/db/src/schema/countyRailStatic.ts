/**
 * Static county-rail metadata (display, ordinal, threshold, sources).
 * Derived fields (`atomFamilyState`, `hasWriter`, etc.) come from
 * `buildEffectiveCountyRailDeclaration()` in `railManifestDerivation.ts`.
 */
import type { CoverageClass, RailKind } from "./countyRailDimension";

export interface CountyRailStaticMetadata {
  railKey: string;
  displayName: string;
  ordinal: number;
  railLetter: string | null;
  kind: RailKind;
  thresholdPct: number;
  coverageClass: CoverageClass;
  declaredSource: string;
  notes: string | null;
}

export const COUNTY_RAIL_STATIC_DECLARATION: ReadonlyArray<CountyRailStaticMetadata> = [
  {
    railKey: "geometry",
    displayName: "Parcel geometry",
    ordinal: 1,
    railLetter: "C",
    kind: "spine",
    thresholdPct: 95,
    coverageClass: "statewide-uniform",
    declaredSource:
      "TxGIO StratMap bulk zip per FIPS; county ArcGIS override where fresher",
    notes: "Spine rail; scorer countyGeometryScoreCli.ts.",
  },
  {
    railKey: "cad",
    displayName: "CAD attributes",
    ordinal: 2,
    railLetter: "B",
    kind: "spine",
    thresholdPct: 95,
    coverageClass: "jurisdiction-depth",
    declaredSource: "County CAD (BIS/PACS/Orion/HCAD), joined to Rail C geometry",
    notes: "Engine writer write-cad-parcel-roll-county.mjs.",
  },
  {
    railKey: "zoning",
    displayName: "Zoning + setback",
    ordinal: 3,
    railLetter: "A",
    kind: "spine",
    thresholdPct: 95,
    coverageClass: "jurisdiction-depth",
    declaredSource: "Municipal code per incorporated city; unincorporated county is unzoned",
    notes: "Typed absence discriminant.",
  },
  {
    railKey: "roads",
    displayName: "Roads / frontage",
    ordinal: 4,
    railLetter: null,
    kind: "spine",
    thresholdPct: 95,
    coverageClass: "statewide-uniform",
    declaredSource: "OSM Overpass plus county roadway layers",
    notes: "road-node not in engine PROPERTY_ENTITY_TYPES 34c94ff.",
  },
  {
    railKey: "flood",
    displayName: "Flood / terrain",
    ordinal: 5,
    railLetter: "D",
    kind: "spine",
    thresholdPct: 95,
    coverageClass: "statewide-uniform",
    declaredSource: "FEMA NFHL, USGS 3DEP, USDA SSURGO",
    notes: "Engine writer write-flood-hazard-fact-county.mjs.",
  },
  {
    railKey: "envelope",
    displayName: "Buildable envelope",
    ordinal: 6,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "jurisdiction-depth",
    declaredSource: "Derived from parcel geometry + zoning/setback + roads",
    notes: "Scorer countyCoverageScoreCli.ts.",
  },
  {
    railKey: "landuse",
    displayName: "Land use",
    ordinal: 7,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "jurisdiction-depth",
    declaredSource: "CAD roll code (cad_property.property_use_code)",
    notes: "Engine + CAD scorer.",
  },
  {
    railKey: "footprint",
    displayName: "Building footprints",
    ordinal: 8,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "statewide-uniform",
    declaredSource: "ML-derived default statewide (Microsoft/Overture/USA Structures)",
    notes: "Engine writer write-building-footprint-county.mjs.",
  },
  {
    railKey: "easement",
    displayName: "Utility easements",
    ordinal: 9,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "jurisdiction-depth",
    declaredSource: "County honest-absence default; CAD exception where published",
    notes: "No writer yet.",
  },
  {
    railKey: "owner",
    displayName: "Owner facet",
    ordinal: 10,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "jurisdiction-depth",
    declaredSource: "CAD owner_name + owner_mailing_address (cad_property)",
    notes: "public-paid; engine writer write-owner-fact-county.mjs.",
  },
  {
    railKey: "rrc-wells",
    displayName: "RRC wells",
    ordinal: 11,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "statewide-uniform",
    declaredSource: "RRC public GIS wells (TXRRC/Wells MapServer/0)",
    notes: "well-fact + write-well-fact-county.mjs.",
  },
  {
    railKey: "rrc-pipelines",
    displayName: "RRC pipelines",
    ordinal: 12,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "statewide-uniform",
    declaredSource: "RRC public GIS pipelines (TXRRC/Pipelines MapServer/0)",
    notes: "No pipeline-fact atom registered.",
  },
  {
    railKey: "rail-corridor",
    displayName: "Rail corridors",
    ordinal: 13,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "statewide-uniform",
    declaredSource: "TxDOT rail inventory / FRA / NTAD",
    notes: "write-rail-corridor-fact-county.mjs.",
  },
  {
    railKey: "mud",
    displayName: "Special districts",
    ordinal: 14,
    railLetter: null,
    kind: "derived",
    thresholdPct: 90,
    coverageClass: "statewide-uniform",
    declaredSource:
      "TCEQ WaterDistricts (tx_special_district); Comptroller SPDPID optional tax-rate enrich",
    notes:
      "special-district-fact on TCEQ polygon PIP; MUD/WCID/MMD/etc. subcategorized via districtType body field (R1). write-special-district-fact-county.mjs.",
  },
];

export const COUNTY_RAIL_STATIC_COUNT = COUNTY_RAIL_STATIC_DECLARATION.length;

export const STATIC_COVERAGE_CLASS_BY_RAIL_KEY: Readonly<Record<string, CoverageClass>> =
  Object.fromEntries(
    COUNTY_RAIL_STATIC_DECLARATION.map((r) => [r.railKey, r.coverageClass]),
  );
