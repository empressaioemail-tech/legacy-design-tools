/**
 * Tier-1 node-facet bake — pure compute helpers (DB-free).
 *
 * The deterministic facet math the bake CLI (nodeFacetBakeTier1Cli.ts) and its
 * unit tests both consume, extracted here so the tests import ONE
 * implementation and the CLI stays a thin DB + paging shell. No `@workspace/db`
 * import (so it loads with no DATABASE_URL), mirroring parcelNodeId.ts /
 * joinNormalize.ts / ptadLandUse.ts.
 *
 * Two pieces:
 *   1. `parcelAcreage` / `ringCentroid` — shoelace area (via the shared
 *      `ringAreaSqFt`) and a cheap average-vertex centroid for the coord index.
 *   2. `computeTier1Envelope` — the SAME deterministic setback + buildable-
 *      envelope composition the buildable-envelope route runs with
 *      `skipRoad=true` (getSetbackTable -> mapDistrict -> labelEdges with NO
 *      roads and NO refPoint -> deriveBuildableEnvelope), packaged into a
 *      snapshot facet marked `provisional` + `roadsPending`. It calls NO live
 *      adapter (no OSM/FEMA/3DEP) — the road-based high-confidence envelope is
 *      Tier 2. Honest absence: an un-mappable jurisdiction/district returns a
 *      `declined` facet (never a fabricated envelope).
 */

import {
  getSetbackTableForZoning,
  type SetbackTable,
} from "@workspace/adapters";
// Import the jurisdiction-key synthesizer from the DB-FREE subpath, NOT the
// `@workspace/codes` barrel — the barrel transitively loads `@workspace/db`
// (throws on a missing DATABASE_URL at module load), which would break this
// offline-safe bake's lazy gcloud DB-url resolution.
import { keyFromEngagementOrSynthesize } from "@workspace/codes/jurisdictions";
import {
  absentZoningDisclosure,
  isAbsentZoningFallback,
  NO_ZONING_STAMP_REASON,
  scrubAbsentZoningGeojson,
} from "./buildableEnvelope/absentZoningHonesty";
import { deriveBuildableEnvelope } from "./buildableEnvelope/derive";
import { labelEdges } from "./buildableEnvelope/edgeLabeling";
import { mapDistrict } from "./buildableEnvelope/districtMapping";
import { ringAreaSqFt, openRing, type Ring } from "./buildableEnvelope/geometry";

export type { Ring };

const SQFT_PER_ACRE = 43_560;

/**
 * Deterministic parcel acreage from the polygon ring via the shared
 * equirectangular shoelace (`ringAreaSqFt`). Returns null for a degenerate
 * (zero-area / unusable) ring — honest absence, never a fabricated 0.
 */
export function parcelAcreage(
  ring: Ring,
): { value: number; sqft: number; method: "shoelace-wgs84" } | null {
  const sqft = ringAreaSqFt(ring);
  if (!Number.isFinite(sqft) || sqft <= 0) return null;
  return {
    value: Math.round((sqft / SQFT_PER_ACRE) * 10_000) / 10_000,
    sqft: Math.round(sqft),
    method: "shoelace-wgs84",
  };
}

/**
 * Cheap centroid (average of the ring's distinct vertices) in lng/lat, used
 * ONLY for the snapshot's (lat_rounded, lng_rounded) coord index — not a
 * load-bearing survey point. Falls back to (0,0) for a degenerate ring.
 */
export function ringCentroid(ring: Ring): { lat: number; lng: number } {
  const pts = openRing(ring);
  if (!pts.length) return { lat: 0, lng: 0 };
  let sx = 0;
  let sy = 0;
  for (const [lng, lat] of pts) {
    sx += lng;
    sy += lat;
  }
  return {
    lat: Math.round((sy / pts.length) * 1e5) / 1e5,
    lng: Math.round((sx / pts.length) * 1e5) / 1e5,
  };
}

export interface Tier1EnvelopeInput {
  ring: Ring;
  zoningCode: string | null;
  situsCity: string | null;
  situsState: string | null;
  situsAddress: string | null;
  /**
   * When situs cannot synthesize a jurisdiction key but the parcel already
   * carries a zoning stamp from a county with exactly one registered city
   * zoning layer, the bake CLI may pass that layer's key here (underscore
   * form). Never invent for multi-city counties.
   */
  zoningJurisdictionFallback?: string | null;
}

export interface Tier1EnvelopeFacet {
  /**
   * - "ok"           : a buildable envelope was derived (provisional).
   * - "no-buildable-area" : setbacks consume the lot (honest empty).
   * - "declined"     : no codified setback jurisdiction / no mappable
   *                    district / unusable geometry — or absent-zoning
   *                    honesty (declineReason no-zoning-stamp) which may
   *                    still carry a conservative-estimate geojson.
   */
  status: "ok" | "no-buildable-area" | "declined";
  /** Always true for Tier 1 — computed WITHOUT roads; Tier 2 upgrades it. */
  provisional: true;
  /** Always true for Tier 1 — road-based labeling is pending (Tier 2). */
  roadsPending: true;
  /** Overall confidence 0..1 (shape-labeling x district). Low by design. */
  confidence: number;
  /** True whenever the envelope should render approximate (Tier 1: always). */
  approximate: boolean;
  /** Why it declined, when status === "declined". */
  declineReason?: string;
  /**
   * Present when status is declined for absent zoning but a conservative
   * estimate shape/setbacks are still attached.
   */
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
  edgeSignal?: string;
  /** The envelope polygon (0 or 1 features), same shape the route emits. */
  geojson?: unknown;
}

/**
 * Compute the Tier-1 (skipRoad, shape-only) buildable envelope for one parcel.
 * Deterministic + owner-free + honest-absence. NEVER calls a live adapter.
 *
 * The composition is byte-for-byte the route's `skipRoad=true` path: resolve
 * the setback table from the parcel's own situs city/state, map the zoning code
 * to a district (conservative fallback when unknown), label edges from LOT
 * SHAPE ONLY (empty roads, null refPoint), and inset. When there is no
 * jurisdiction key, no setback table, no district, or an unusable ring, it
 * DECLINES honestly rather than fabricate an envelope.
 */
export function computeTier1Envelope(
  input: Tier1EnvelopeInput,
): Tier1EnvelopeFacet {
  const base = { provisional: true, roadsPending: true } as const;

  const fromSitus = keyFromEngagementOrSynthesize({
    jurisdictionCity: input.situsCity,
    jurisdictionState: input.situsState,
    address: input.situsAddress ?? undefined,
  });
  // Zoning-layer fallback only when (a) situs failed, (b) a sole-city key was
  // supplied by the bake CLI, and (c) the parcel actually has a zoning stamp
  // — never use the fallback to invent jurisdiction on unzoned parcels.
  const jurisdictionKey =
    fromSitus ??
    (input.zoningCode && input.zoningJurisdictionFallback
      ? input.zoningJurisdictionFallback
      : null);
  if (!jurisdictionKey) {
    return {
      ...base,
      status: "declined",
      confidence: 0,
      approximate: true,
      declineReason: "no-jurisdiction-key",
      jurisdictionKey: null,
    };
  }

  const table: SetbackTable | null = getSetbackTableForZoning(
    jurisdictionKey,
    input.zoningCode,
  );
  if (!table || table.districts.length === 0) {
    return {
      ...base,
      status: "declined",
      confidence: 0,
      approximate: true,
      declineReason: table ? "setback-table-pending" : "no-setback-table",
      jurisdictionKey,
    };
  }

  const district = mapDistrict(table, input.zoningCode);
  if (!district) {
    return {
      ...base,
      status: "declined",
      confidence: 0,
      approximate: true,
      // Table exists but GIS code (or missing code) has no scalar row yet.
      declineReason: input.zoningCode
        ? "setback-table-pending"
        : "no-district",
      jurisdictionKey,
    };
  }

  // Lot-shape-only labeling: NO roads (Tier 2), NO refPoint. This forces the
  // `frontFromShape` low-confidence (0.35) path — the provisional Tier-1
  // envelope. Passing situsAddress lets the (empty) road path stay a no-op.
  const labeling = labelEdges({
    ring: input.ring,
    roads: [],
    refPoint: null,
    situsAddress: input.situsAddress,
  });
  if (!labeling) {
    return {
      ...base,
      status: "declined",
      confidence: 0,
      approximate: true,
      declineReason: "ungeometric-parcel",
      jurisdictionKey,
    };
  }

  const derived = deriveBuildableEnvelope({
    ring: input.ring,
    table,
    district,
    labeling,
  });

  const props = derived.geojson.features[0]?.properties;
  const setbacks = props
    ? {
        front_ft: props.setbacks.front_ft,
        side_ft: props.setbacks.side_ft,
        rear_ft: props.setbacks.rear_ft,
      }
    : undefined;

  // Absent zoning: draw a conservative estimate, never stamp a district name.
  if (isAbsentZoningFallback(district) && setbacks) {
    const geojson = scrubAbsentZoningGeojson(derived.geojson, setbacks);
    return {
      ...base,
      status: "declined",
      declineReason: NO_ZONING_STAMP_REASON,
      matchKind: "fallback-conservative",
      confidence: derived.confidence,
      approximate: true,
      jurisdictionKey,
      // deliberately omit district — do not assert the conservative row name
      setbacks,
      parcelAreaSqFt: props?.parcelAreaSqFt,
      buildableAreaSqFt: props?.buildableAreaSqFt,
      buildableAreaPct: props?.buildableAreaPct,
      maxLotCoveragePct: props?.maxLotCoveragePct ?? null,
      maxHeightFt: props?.maxHeightFt ?? null,
      maxFootprintSqFt: props?.maxFootprintSqFt ?? null,
      citationUrl: derived.citationUrl,
      disclosure: absentZoningDisclosure(setbacks),
      edgeSignal: props?.edgeSignal,
      geojson,
    };
  }

  return {
    ...base,
    status: derived.empty ? "no-buildable-area" : "ok",
    confidence: derived.confidence,
    approximate: derived.approximate,
    jurisdictionKey,
    district: derived.district,
    setbacks,
    parcelAreaSqFt: props?.parcelAreaSqFt,
    buildableAreaSqFt: props?.buildableAreaSqFt,
    buildableAreaPct: props?.buildableAreaPct,
    maxLotCoveragePct: props?.maxLotCoveragePct ?? null,
    maxHeightFt: props?.maxHeightFt ?? null,
    maxFootprintSqFt: props?.maxFootprintSqFt ?? null,
    citationUrl: derived.citationUrl,
    disclosure: props?.disclosure,
    edgeSignal: props?.edgeSignal,
    geojson: derived.geojson,
  };
}
