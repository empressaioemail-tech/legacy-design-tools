/**
 * Tier-1 node-facet bake - pure compute helpers (DB-free).
 *
 * Anti-zombie cut (Master WDLL 3.7 / I-A): Tier-1 no longer writes a bespoke
 * buildable envelope via `labeling×district product`. Product
 * envelope truth is the atom-chain path. This module still exposes acreage /
 * centroid helpers and an honest `atom_path_pending` envelope decline so the
 * bake CLI can record coverage without inventing multiply confidence.
 */

import { ringAreaSqFt, openRing, type Ring } from "./buildableEnvelope/geometry";
import { NO_ZONING_STAMP_REASON } from "./buildableEnvelope/absentZoningHonesty";

export type { Ring };

const SQFT_PER_ACRE = 43_560;

/**
 * Deterministic parcel acreage from the polygon ring via the shared
 * equirectangular shoelace (`ringAreaSqFt`). Returns null for a degenerate
 * (zero-area / unusable) ring - honest absence, never a fabricated 0.
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
 * ONLY for the snapshot's (lat_rounded, lng_rounded) coord index - not a
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
  zoningJurisdictionFallback?: string | null;
}

export interface Tier1EnvelopeFacet {
  status: "ok" | "no-buildable-area" | "declined";
  provisional: true;
  roadsPending: true;
  /** Always null - product confidence is atom readContract only. */
  confidence: number | null;
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
  edgeSignal?: string;
  geojson?: unknown;
}

/**
 * Honest Tier-1 envelope slot: never compute multiply confidence.
 * Absent zoning â†’ no-zoning-stamp dialect; otherwise atom_path_pending.
 */
export function computeTier1Envelope(
  input: Tier1EnvelopeInput,
): Tier1EnvelopeFacet {
  const base = {
    provisional: true as const,
    roadsPending: true as const,
    confidence: null,
    approximate: true,
  };

  if (!input.zoningCode || !input.zoningCode.trim()) {
    return {
      ...base,
      status: "declined",
      declineReason: NO_ZONING_STAMP_REASON,
      disclosure:
        "No zoning stamp on this parcel - honest absence; envelope via atom path when present.",
      jurisdictionKey: null,
    };
  }

  return {
    ...base,
    status: "declined",
    declineReason: "atom_path_pending",
    disclosure:
      "Tier-1 bake no longer authors product envelope confidence (anti-zombie). " +
      "Read buildable-envelope from the property atom chain, or honest-decline.",
    jurisdictionKey: input.zoningJurisdictionFallback ?? null,
  };
}

