/**
 * Tier-2 node-facet bake — pure compute helpers (DB-free, live-dep-shaped).
 *
 * Tier 2 is the LIVE-EXTERNAL-DEPENDENCY layer of the node-facet bake. Where
 * Tier 1 (nodeFacetBakeTier1.ts) computed everything DB-local + deterministic
 * — including the buildable envelope WITHOUT roads (the skipRoad / lot-shape
 * path, marked `provisional` + `roadsPending`) — Tier 2 upgrades exactly the
 * facets that need an external fetch:
 *
 *   1. ENVELOPE UPGRADE (roads). The Tier-1 envelope guessed the front edge
 *      from lot shape alone (low confidence, `roadsPending: true`). Tier 2
 *      re-labels the parcel's front edge from the nearest OSM road centerline
 *      (the same road signal the buildable-envelope route uses), producing a
 *      HIGH-confidence envelope carrying `roadsPending: false` + the road
 *      source. Because higher confidence scores higher, the Tier-1 monotonic
 *      guard PROMOTES it — that is the guard working as intended, not a fight.
 *      Honest degradation (commitment #1): when the road fetch fails or returns
 *      no usable candidate, labeling falls back to the geocoded centroid
 *      (`point`) or lot shape (`shape`) exactly as the route does, and the
 *      facet records which signal actually fired. A failed fetch NEVER
 *      fabricates a road-based front; it degrades and says so.
 *
 *   2. FEMA FLOOD (NFHL). A per-node point-query against the FEMA National
 *      Flood Hazard Layer (layer 28) yields the parcel's effective flood zone
 *      (AE / X / VE / …), SFHA flag, and BFE, carrying the FEMA vintage. Honest
 *      absence: a FEMA OUTAGE stores `status: "unavailable"` (never a fabricated
 *      zone); a clean empty result stores `status: "outside-sfha"` (the parcel
 *      is genuinely outside any mapped flood zone — effectively Zone X — which
 *      is a real, citeable answer, not an absence).
 *
 * This module is PURE: it consumes an already-fetched road candidate list and
 * an already-fetched FEMA arcgis result and returns the two facets + a
 * monotonic score. ALL network I/O (the tile-cached Overpass fetch, the FEMA
 * point query) lives in the CLI (nodeFacetBakeTier2Cli.ts), which is where the
 * cache-first tile batching that makes a county bake affordable also lives.
 * Keeping the fetch out of here is what lets the unit tests exercise every
 * branch (upgrade / degrade / flood / outside / unavailable) offline.
 *
 * No `@workspace/db` import (loads with no DATABASE_URL), mirroring
 * nodeFacetBakeTier1.ts.
 */

import { deriveBuildableEnvelope } from "./buildableEnvelope/derive";
import {
  labelEdges,
  type RoadCandidate,
} from "./buildableEnvelope/edgeLabeling";
import { mapDistrict } from "./buildableEnvelope/districtMapping";
import {
  getSetbackTableForZoning,
  type SetbackTable,
} from "@workspace/adapters";
import { keyFromEngagementOrSynthesize } from "@workspace/codes/jurisdictions";
import type { Ring } from "./buildableEnvelope/geometry";

// ---------------------------------------------------------------------------
// Envelope upgrade (road-based front-edge labeling).
// ---------------------------------------------------------------------------

export interface Tier2EnvelopeInput {
  ring: Ring;
  zoningCode: string | null;
  situsCity: string | null;
  situsState: string | null;
  situsAddress: string | null;
  /**
   * Nearby OSM road candidates for THIS parcel, already fetched (tile-cached)
   * by the CLI. An empty array means the road fetch was attempted and produced
   * nothing usable (rural parcel, or an Overpass outage the CLI could not clear
   * even with retry) — labeling then degrades to the centroid/shape signal.
   */
  roads: RoadCandidate[];
  /**
   * The parcel centroid, used as the geocoded-point fallback signal when no
   * road candidate produces a trustworthy front edge. This is the SAME medium-
   * confidence `point` signal the buildable-envelope route uses; it is strictly
   * better than pure lot shape.
   */
  refPoint: { lng: number; lat: number } | null;
  /**
   * Whether a road fetch was even ATTEMPTED for this node (false when the CLI
   * skipped it — e.g. a node with no usable centroid). Drives `roadFetch`
   * provenance so an absent road signal is honestly attributable.
   */
  roadFetchAttempted: boolean;
}

export interface Tier2EnvelopeFacet {
  /**
   * - "ok"                : a buildable envelope was derived.
   * - "no-buildable-area" : setbacks consume the lot (honest empty).
   * - "declined"          : no codified setback jurisdiction / no mappable
   *                         district / unusable geometry (honest).
   */
  status: "ok" | "no-buildable-area" | "declined";
  /** Tier 2 is NO LONGER provisional when the road signal fired. */
  provisional: boolean;
  /** False once Tier 2 has resolved the road signal (the whole point of T2). */
  roadsPending: false;
  /** Which signal produced the front edge: road (high) / point / shape (low). */
  edgeSignal: "road" | "point" | "shape";
  /** Overall confidence 0..1 (labeling x district). */
  confidence: number;
  approximate: boolean;
  declineReason?: string;
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
  /** Provenance of the road signal, so an absent/degraded signal is honest. */
  roadProvenance: {
    /** Was a road fetch attempted for this node at all? */
    fetchAttempted: boolean;
    /** How many road candidates the fetch returned (0 == empty/outage). */
    candidateCount: number;
    /** True when the road signal actually won the front edge (signal==road). */
    roadSignalUsed: boolean;
    /** OSM Overpass is the only in-tree road source. */
    source: "osm-overpass";
  };
}

/**
 * Compute the Tier-2 (road-based) buildable envelope for one parcel. Pure +
 * owner-free + honest-absence. The composition is byte-for-byte the route's
 * FULL (non-skipRoad) path: resolve the setback table from situs, map the
 * zoning district, label edges preferring the nearest road (then centroid,
 * then shape), and inset. When there is no jurisdiction / table / district /
 * usable ring, it DECLINES honestly.
 *
 * The only difference from Tier 1's `computeTier1Envelope` is that `roads` and
 * `refPoint` are POPULATED here, so `labelEdges` can fire its high-confidence
 * `road` (or medium `point`) signal instead of being forced onto the low-
 * confidence `shape` fallback. Everything else — the honesty envelope, the
 * disclosure, the declined-status handling — is identical.
 */
export function computeTier2Envelope(
  input: Tier2EnvelopeInput,
): Tier2EnvelopeFacet {
  const roadProvenanceBase = {
    fetchAttempted: input.roadFetchAttempted,
    candidateCount: input.roads.length,
    source: "osm-overpass" as const,
  };
  const declined = (
    declineReason: string,
    jurisdictionKey: string | null,
  ): Tier2EnvelopeFacet => ({
    status: "declined",
    provisional: true,
    roadsPending: false,
    edgeSignal: "shape",
    confidence: 0,
    approximate: true,
    declineReason,
    jurisdictionKey,
    roadProvenance: { ...roadProvenanceBase, roadSignalUsed: false },
  });

  const jurisdictionKey = keyFromEngagementOrSynthesize({
    jurisdictionCity: input.situsCity,
    jurisdictionState: input.situsState,
    address: input.situsAddress ?? undefined,
  });
  if (!jurisdictionKey) return declined("no-jurisdiction-key", null);

  const table: SetbackTable | null = getSetbackTableForZoning(
    jurisdictionKey,
    input.zoningCode,
  );
  if (!table || table.districts.length === 0) {
    return declined(
      table ? "setback-table-pending" : "no-setback-table",
      jurisdictionKey,
    );
  }

  const district = mapDistrict(table, input.zoningCode);
  if (!district) {
    return declined(
      input.zoningCode ? "setback-table-pending" : "no-district",
      jurisdictionKey,
    );
  }

  // The upgrade: pass the fetched roads + centroid refPoint. labelEdges prefers
  // the road signal (high, situs-named cul-de-sac defense included), degrades
  // to the point signal, then to shape — all HONESTLY reported via signal.
  const labeling = labelEdges({
    ring: input.ring,
    roads: input.roads,
    refPoint: input.refPoint,
    situsAddress: input.situsAddress,
  });
  if (!labeling) return declined("ungeometric-parcel", jurisdictionKey);

  const derived = deriveBuildableEnvelope({
    ring: input.ring,
    table,
    district,
    labeling,
  });

  const props = derived.geojson.features[0]?.properties;
  const roadSignalUsed = labeling.signal === "road";
  return {
    status: derived.empty ? "no-buildable-area" : "ok",
    // Provisional only when the front edge is STILL a pure-shape guess (the
    // road fetch produced nothing and there was no usable centroid). A road- or
    // point-labeled envelope is no longer the Tier-1-grade shape guess.
    provisional: labeling.signal === "shape",
    roadsPending: false,
    edgeSignal: labeling.signal,
    confidence: derived.confidence,
    approximate: derived.approximate,
    jurisdictionKey,
    district: derived.district,
    setbacks: props
      ? {
          front_ft: props.setbacks.front_ft,
          side_ft: props.setbacks.side_ft,
          rear_ft: props.setbacks.rear_ft,
        }
      : undefined,
    parcelAreaSqFt: props?.parcelAreaSqFt,
    buildableAreaSqFt: props?.buildableAreaSqFt,
    buildableAreaPct: props?.buildableAreaPct,
    maxLotCoveragePct: props?.maxLotCoveragePct ?? null,
    maxHeightFt: props?.maxHeightFt ?? null,
    maxFootprintSqFt: props?.maxFootprintSqFt ?? null,
    citationUrl: derived.citationUrl,
    disclosure: props?.disclosure,
    geojson: derived.geojson,
    roadProvenance: { ...roadProvenanceBase, roadSignalUsed },
  };
}

// ---------------------------------------------------------------------------
// FEMA flood facet (from a FEMA NFHL arcgis point-query result).
// ---------------------------------------------------------------------------

/**
 * The minimal shape of an ArcGIS point-query result the flood parser consumes
 * — a `features` list of `{ attributes }`. Structurally compatible with
 * `ArcGisQueryResult` from `@workspace/adapters/arcgis` so the CLI can pass the
 * live result straight in, while the tests can hand-build one offline.
 */
export interface FemaQueryLike {
  features: { attributes: Record<string, unknown> }[];
}

export interface Tier2FloodFacet {
  /**
   * - "in-sfha"      : parcel intersects a mapped Special Flood Hazard Area
   *                    (an AE/VE/A/AO/AH… zone). `floodZone` is populated.
   * - "flood-zone"   : parcel intersects a mapped, NON-SFHA zone (e.g. X
   *                    shaded / 0.2% annual chance). `floodZone` is populated.
   * - "outside-sfha" : the query SUCCEEDED and returned no intersecting zone —
   *                    the parcel is outside any mapped flood zone (effectively
   *                    Zone X). A real, citeable answer, NOT an absence.
   * - "unavailable"  : the FEMA fetch FAILED (outage / non-JSON / query error).
   *                    Honest absence — never a fabricated zone (commitment #1).
   */
  status: "in-sfha" | "flood-zone" | "outside-sfha" | "unavailable";
  /** FEMA flood zone code (AE, X, VE, …). Null when outside-sfha/unavailable. */
  floodZone: string | null;
  /** FEMA SFHA_TF normalized to a boolean. Null when unavailable. */
  inSpecialFloodHazardArea: boolean | null;
  /** Zone subtype (FLOODWAY, "0.2 PCT ANNUAL CHANCE FLOOD HAZARD", …). */
  zoneSubtype: string | null;
  /** Static base flood elevation (feet), when FEMA carries one. */
  baseFloodElevation: number | null;
  provenance: {
    source: "fema-nfhl";
    adapterKey: "fema:nfhl-flood-zone";
    layer: "flood-hazard-zones";
    /** FEMA vintage (the read timestamp — a FEMA reading is as-of when read). */
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
    payload.envelope != null && payload.envelope.status !== "declined";
  const floodResolved = payload.flood.status !== "unavailable";
  const facetCount = (envelopeResolved ? 1 : 0) + (floodResolved ? 1 : 0);
  const conf = payload.envelope?.confidence ?? 0;
  return facetCount * 1000 + Math.round(conf * 100);
}
