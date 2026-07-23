/**
 * Tier-2 node-facet bake — pure compute helpers (DB-free, live-dep-shaped).
 *
 * Anti-zombie cut (Master WDLL 3.7 / I-A): Tier-2 no longer authors a bespoke
 * buildable envelope via labeling×district multiply. Flood overlay remains.
 * Product envelope is the atom-chain path; this helper returns honest
 * `atom_path_pending` / `no-zoning-stamp` declines only.
 */

import { NO_ZONING_STAMP_REASON } from "./buildableEnvelope/absentZoningHonesty";
import type { RoadCandidate } from "./buildableEnvelope/edgeLabeling";
import type { Ring } from "./buildableEnvelope/geometry";

// ---------------------------------------------------------------------------
// Envelope upgrade slot (retired multiply path — honest decline only).
// ---------------------------------------------------------------------------

export interface Tier2EnvelopeInput {
  ring: Ring;
  zoningCode: string | null;
  situsCity: string | null;
  situsState: string | null;
  situsAddress: string | null;
  roads: RoadCandidate[];
  refPoint: { lng: number; lat: number } | null;
  roadFetchAttempted: boolean;
}

export interface Tier2EnvelopeFacet {
  status: "ok" | "no-buildable-area" | "declined";
  provisional: boolean;
  roadsPending: false;
  edgeSignal: "road" | "point" | "shape";
  /** Always null — product confidence is atom readContract only. */
  confidence: null;
  approximate: boolean;
  declineReason?: string;
  matchKind?: "fallback-conservative";
  jurisdictionKey?: string | null;
  district?: string;
  setbacks?: { front_ft: number; side_ft: number; rear_ft: number };
  parcelAreaSqFt?: number;
  buildableAreaSqFt?: number;
  buildableAreaPct?: number;
  maxLotCoveragePct?: number | null;
  maxHeightFt?: number | null;
  maxFootprintSqFt?: number | null;
  citationUrl?: string;
  disclosure?: string;
  geojson?: unknown;
  roadProvenance: {
    fetchAttempted: boolean;
    candidateCount: number;
    roadSignalUsed: boolean;
    source: "osm-overpass";
  };
}

/**
 * Honest Tier-2 envelope slot: never compute multiply confidence.
 * Flood remains the Tier-2 product facet; envelope is atom-path only.
 */
export function computeTier2Envelope(
  input: Tier2EnvelopeInput,
): Tier2EnvelopeFacet {
  const roadProvenance = {
    fetchAttempted: input.roadFetchAttempted,
    candidateCount: input.roads.length,
    roadSignalUsed: false,
    source: "osm-overpass" as const,
  };

  if (!input.zoningCode || !input.zoningCode.trim()) {
    return {
      status: "declined",
      provisional: true,
      roadsPending: false,
      edgeSignal: "shape",
      confidence: null,
      approximate: true,
      declineReason: NO_ZONING_STAMP_REASON,
      disclosure:
        "No zoning stamp — honest absence; envelope via atom path when present.",
      jurisdictionKey: null,
      roadProvenance,
    };
  }

  return {
    status: "declined",
    provisional: true,
    roadsPending: false,
    edgeSignal: input.roads.length > 0 ? "road" : "shape",
    confidence: null,
    approximate: true,
    declineReason: "atom_path_pending",
    disclosure:
      "Tier-2 bake no longer authors product envelope confidence (anti-zombie). " +
      "Read buildable-envelope from the property atom chain, or honest-decline. " +
      "Flood overlay remains on this tier.",
    jurisdictionKey: null,
    roadProvenance,
  };
}

// FEMA flood facet (from a FEMA NFHL arcgis point-query result).
// ---------------------------------------------------------------------------

/**
 * The minimal shape of an ArcGIS point-query result the flood parser consumes
 * - a `features` list of `{ attributes }`. Structurally compatible with
 * `ArcGisQueryResult` from `@workspace/adapters/arcgis` so the CLI can pass the
 * live result straight in, while the tests can hand-build one offline.
 */
export interface FemaQueryLike {
  features: { attributes: Record<string, unknown> }[];
}

export interface Tier2FloodFacet {
  /**
   * - "in-sfha"      : parcel intersects a mapped Special Flood Hazard Area
   *                    (an AE/VE/A/AO/AH... zone). `floodZone` is populated.
   * - "flood-zone"   : parcel intersects a mapped, NON-SFHA zone (e.g. X
   *                    shaded / 0.2% annual chance). `floodZone` is populated.
   * - "outside-sfha" : the query SUCCEEDED and returned no intersecting zone -
   *                    the parcel is outside any mapped flood zone (effectively
   *                    Zone X). A real, citeable answer, NOT an absence.
   * - "unavailable"  : the FEMA fetch FAILED (outage / non-JSON / query error).
   *                    Honest absence - never a fabricated zone (commitment #1).
   */
  status: "in-sfha" | "flood-zone" | "outside-sfha" | "unavailable";
  /** FEMA flood zone code (AE, X, VE, ...). Null when outside-sfha/unavailable. */
  floodZone: string | null;
  /** FEMA SFHA_TF normalized to a boolean. Null when unavailable. */
  inSpecialFloodHazardArea: boolean | null;
  /** Zone subtype (FLOODWAY, "0.2 PCT ANNUAL CHANCE FLOOD HAZARD", ...). */
  zoneSubtype: string | null;
  /** Static base flood elevation (feet), when FEMA carries one. */
  baseFloodElevation: number | null;
  provenance: {
    source: "fema-nfhl";
    adapterKey: "fema:nfhl-flood-zone";
    layer: "flood-hazard-zones";
    /** FEMA vintage (the read timestamp - a FEMA reading is as-of when read). */
    vintage: string;
    /** Why the facet is unavailable, when status === "unavailable". */
    unavailableReason?: string;
  };
}

/** FEMA stamps SFHA_TF as the literal "T"/"F"; some layers a boolean. */
function normalizeSfha(v: unknown): boolean {
  return v === "T" || v === true;
}

/** SFHA zone codes (the 1% annual-chance floodplain). X and D are NON-SFHA. */
const SFHA_ZONE_PREFIXES = ["A", "V"] as const;

function isSfhaZone(zone: string | null, sfhaFlag: boolean): boolean {
  if (sfhaFlag) return true;
  if (!zone) return false;
  const z = zone.trim().toUpperCase();
  // "X" and "D" are explicitly non-SFHA even though X does not start with A/V;
  // the flag is authoritative, but fall back to the code prefix when FEMA left
  // SFHA_TF blank on an older panel.
  if (z === "X" || z === "D" || z.startsWith("X")) return false;
  return SFHA_ZONE_PREFIXES.some((p) => z.startsWith(p));
}

/**
 * Build the Tier-2 FEMA flood facet from a NFHL point-query result. Pure +
 * honest-absence. `queryResult === null` (or an explicit failure marker) means
 * the fetch FAILED -> `unavailable` (never a fabricated zone). A successful but
 * empty `features` list means the parcel is outside any mapped zone ->
 * `outside-sfha` (a real answer). This mirrors the femaNfhlAdapter's own
 * empty-vs-hit handling so a Tier-2 facet reads the same as a live adapter run.
 */
export function buildFloodFacet(
  queryResult: FemaQueryLike | null,
  nowIso: string,
  unavailableReason?: string,
): Tier2FloodFacet {
  const provenanceBase = {
    source: "fema-nfhl" as const,
    adapterKey: "fema:nfhl-flood-zone" as const,
    layer: "flood-hazard-zones" as const,
    vintage: nowIso,
  };

  if (!queryResult) {
    return {
      status: "unavailable",
      floodZone: null,
      inSpecialFloodHazardArea: null,
      zoneSubtype: null,
      baseFloodElevation: null,
      provenance: {
        ...provenanceBase,
        unavailableReason: unavailableReason ?? "FEMA NFHL fetch failed",
      },
    };
  }

  if (!Array.isArray(queryResult.features) || queryResult.features.length === 0) {
    // Query succeeded, no intersecting zone: outside any mapped flood zone.
    return {
      status: "outside-sfha",
      floodZone: null,
      inSpecialFloodHazardArea: false,
      zoneSubtype: null,
      baseFloodElevation: null,
      provenance: provenanceBase,
    };
  }

  const attrs = queryResult.features[0]!.attributes ?? {};
  const floodZone =
    typeof attrs.FLD_ZONE === "string" && attrs.FLD_ZONE.trim()
      ? attrs.FLD_ZONE.trim()
      : null;
  const sfhaFlag = normalizeSfha(attrs.SFHA_TF);
  const inSfha = isSfhaZone(floodZone, sfhaFlag);
  const zoneSubtype =
    typeof attrs.ZONE_SUBTY === "string" && attrs.ZONE_SUBTY.trim()
      ? attrs.ZONE_SUBTY.trim()
      : null;
  const bfe =
    typeof attrs.STATIC_BFE === "number" &&
    Number.isFinite(attrs.STATIC_BFE) &&
    // FEMA stamps -9999 as a "no BFE" sentinel; never surface it as a real BFE.
    attrs.STATIC_BFE > -9000
      ? attrs.STATIC_BFE
      : null;

  return {
    status: inSfha ? "in-sfha" : "flood-zone",
    floodZone,
    inSpecialFloodHazardArea: inSfha,
    zoneSubtype,
    baseFloodElevation: bfe,
    provenance: provenanceBase,
  };
}

// ---------------------------------------------------------------------------
// Tier-2 monotonic scoring (verify-before-promote, same shape as Tier 1).
// ---------------------------------------------------------------------------

/**
 * Score a Tier-2 facet pair for the monotonic guard. Primary axis: number of
 * Tier-2 facets that resolved to REAL content (an upgraded envelope, a
 * real/absent-but-answered flood facet); secondary axis: envelope confidence.
 * Higher == better == the one to keep. A flood `unavailable` is NOT a resolved
 * facet (honest absence should never out-score a real prior reading), whereas
 * `outside-sfha` IS a resolved answer.
 *
 * Encoded as `facetCount * 1000 + round(confidence*100)`, matching the Tier-1
 * `facetScore` convention so the same `>=`-promotes logic applies.
 */
export function tier2FacetScore(payload: {
  envelope: Tier2EnvelopeFacet | null;
  flood: Tier2FloodFacet;
}): number {
  const envelopeResolved =
    payload.envelope != null &&
    (payload.envelope.status !== "declined" ||
      payload.envelope.declineReason === NO_ZONING_STAMP_REASON);
  const floodResolved = payload.flood.status !== "unavailable";
  const facetCount = (envelopeResolved ? 1 : 0) + (floodResolved ? 1 : 0);
  const conf = 0; // envelope confidence retired (atom path)
  return facetCount * 1000 + Math.round(conf * 100);
}


