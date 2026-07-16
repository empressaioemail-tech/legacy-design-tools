/**
 * Opportunity Zone national layer — CDFI/HUD designated tracts (75i task 10).
 */

import { readFileSync, existsSync } from "node:fs";
import type { Adapter, AdapterContext, AdapterResult } from "@workspace/adapters";
import { AdapterRunError } from "@workspace/adapters/types";
import {
  OZ_TRACT_LIST_VERSION,
  resolveOzTractDataPath,
} from "./brokerageFederalDataPaths";

export { OZ_TRACT_LIST_VERSION };

export interface OzTractFeature {
  type: "Feature";
  properties: {
    geoid10?: string;
    tractce?: string;
    countyfp?: string;
    statefp?: string;
    round?: string;
    [key: string]: unknown;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface OzCoverageBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface OzTractCollectionMetadata {
  version?: string;
  designationRound?: string;
  source?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  nationalDesignatedTractCount?: number;
  nationalCountNote?: string;
  bundledScope?: string;
  bundledScopeCountyFips?: string[];
  bundledScopeReason?: string;
  bundledCoverageBbox?: OzCoverageBbox;
  bundledTractCount?: number;
  coordinatePrecisionDecimals?: number;
  note?: string;
  [key: string]: unknown;
}

interface OzTractCollection {
  type: "FeatureCollection";
  metadata?: OzTractCollectionMetadata;
  features: OzTractFeature[];
}

let cachedTracts: OzTractCollection | null = null;

function fixturePath(): string {
  const hit = resolveOzTractDataPath();
  if (!existsSync(hit)) {
    throw new AdapterRunError(
      "no-coverage",
      `Opportunity Zone tract data not found at ${hit} (version ${OZ_TRACT_LIST_VERSION}).`,
    );
  }
  return hit;
}

export function loadOzTractFixture(): OzTractCollection {
  if (cachedTracts) return cachedTracts;
  const raw = readFileSync(fixturePath(), "utf8");
  cachedTracts = JSON.parse(raw) as OzTractCollection;
  return cachedTracts;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(
  lng: number,
  lat: number,
  geometry: OzTractFeature["geometry"],
): boolean {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    if (!rings[0]) return false;
    return pointInRing(lng, lat, rings[0]);
  }
  for (const poly of geometry.coordinates as number[][][][]) {
    if (poly[0] && pointInRing(lng, lat, poly[0])) return true;
  }
  return false;
}

export function lookupOpportunityZone(input: {
  latitude: number;
  longitude: number;
  censusTractFips?: string | null;
}): {
  inOpportunityZone: boolean;
  tractGeoid: string | null;
  ozRound: string;
  tractListVersion: string;
  matchMethod: "census-tract-fips" | "point-in-polygon" | "none";
} {
  const collection = loadOzTractFixture();
  const round = OZ_TRACT_LIST_VERSION;

  if (input.censusTractFips) {
    const normalized = input.censusTractFips.replace(/\D/g, "");
    const hit = collection.features.find((f) => {
      const geoid = String(f.properties.geoid10 ?? "").replace(/\D/g, "");
      return geoid && geoid === normalized;
    });
    if (hit) {
      return {
        inOpportunityZone: true,
        tractGeoid: String(hit.properties.geoid10 ?? normalized),
        ozRound: String(hit.properties.round ?? round),
        tractListVersion: round,
        matchMethod: "census-tract-fips",
      };
    }
  }

  for (const feature of collection.features) {
    if (
      pointInPolygonCoords(
        input.longitude,
        input.latitude,
        feature.geometry,
      )
    ) {
      return {
        inOpportunityZone: true,
        tractGeoid: String(feature.properties.geoid10 ?? ""),
        ozRound: String(feature.properties.round ?? round),
        tractListVersion: round,
        matchMethod: "point-in-polygon",
      };
    }
  }

  return {
    inOpportunityZone: false,
    tractGeoid: null,
    ozRound: round,
    tractListVersion: round,
    matchMethod: "none",
  };
}

/** Provenance for the currently-loaded OZ tract layer (source, vintage, scope). */
export function ozTractLayerProvenance(): {
  source: string;
  sourceUrl: string | null;
  designationRound: string;
  dataVintage: string | null;
  tractListVersion: string;
  nationalDesignatedTractCount: number | null;
  nationalCountNote: string | null;
  bundledScope: string | null;
  bundledTractCount: number;
  coverageBbox: OzCoverageBbox | null;
} {
  const collection = loadOzTractFixture();
  const meta = collection.metadata ?? {};
  return {
    source: meta.source ?? "CDFI Fund / HUD (OZ tracts)",
    sourceUrl: meta.sourceUrl ?? null,
    designationRound:
      meta.designationRound ??
      "2018 designation under the Tax Cuts and Jobs Act of 2017",
    dataVintage: meta.retrievedAt ?? null,
    tractListVersion: OZ_TRACT_LIST_VERSION,
    nationalDesignatedTractCount: meta.nationalDesignatedTractCount ?? null,
    nationalCountNote: meta.nationalCountNote ?? null,
    bundledScope: meta.bundledScope ?? null,
    bundledTractCount: meta.bundledTractCount ?? collection.features.length,
    coverageBbox: ozLayerCoverageEnvelope(),
  };
}

interface OzBboxEnvelope {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

let cachedCoverageEnvelope: OzCoverageBbox | null | undefined;

/**
 * The geographic coverage envelope of the currently-loaded OZ dataset.
 *
 * Prefers the explicit `metadata.bundledCoverageBbox` (bundled Central-TX file),
 * otherwise derives the bbox union of every loaded tract geometry (e.g. the
 * GCS-hydrated national set, which carries no bundledCoverageBbox). Returns null
 * only if there is no usable geometry. Used to distinguish an in-scope empty
 * viewport (confident "no OZ here") from an out-of-scope viewport (unknown —
 * the layer simply does not cover that region in this environment).
 */
export function ozLayerCoverageEnvelope(): OzCoverageBbox | null {
  if (cachedCoverageEnvelope !== undefined) return cachedCoverageEnvelope;
  const collection = loadOzTractFixture();
  const declared = collection.metadata?.bundledCoverageBbox;
  if (
    declared &&
    Number.isFinite(declared.westLng) &&
    Number.isFinite(declared.southLat) &&
    Number.isFinite(declared.eastLng) &&
    Number.isFinite(declared.northLat)
  ) {
    cachedCoverageEnvelope = declared;
    return cachedCoverageEnvelope;
  }
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const feature of collection.features) {
    const gb = geometryBbox(feature.geometry);
    if (!gb) continue;
    if (gb.minLng < minLng) minLng = gb.minLng;
    if (gb.minLat < minLat) minLat = gb.minLat;
    if (gb.maxLng > maxLng) maxLng = gb.maxLng;
    if (gb.maxLat > maxLat) maxLat = gb.maxLat;
  }
  cachedCoverageEnvelope = Number.isFinite(minLng)
    ? { westLng: minLng, southLat: minLat, eastLng: maxLng, northLat: maxLat }
    : null;
  return cachedCoverageEnvelope;
}

/**
 * True when the requested viewport lies within (overlaps) the loaded OZ
 * dataset's coverage envelope, i.e. the layer can speak to this region. A
 * viewport that does not overlap the envelope is out-of-scope: absence of a
 * tract there is "unknown", not "confidently none".
 */
export function bboxWithinOzCoverage(bbox: OzBboxEnvelope): boolean {
  const env = ozLayerCoverageEnvelope();
  if (!env) return false;
  return (
    env.westLng <= bbox.eastLng &&
    env.eastLng >= bbox.westLng &&
    env.southLat <= bbox.northLat &&
    env.northLat >= bbox.southLat
  );
}

export function __resetOzCoverageEnvelopeForTests(): void {
  cachedCoverageEnvelope = undefined;
}

function ringBbox(
  ring: number[][],
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  if (!ring.length) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring as [number, number][]) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

function geometryBbox(
  geometry: OzTractFeature["geometry"],
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  const rings: number[][][] =
    geometry.type === "Polygon"
      ? (geometry.coordinates as number[][][])
      : (geometry.coordinates as number[][][][]).flatMap((poly) => poly);
  let acc: {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
  } | null = null;
  for (const ring of rings) {
    const rb = ringBbox(ring);
    if (!rb) continue;
    acc = acc
      ? {
          minLng: Math.min(acc.minLng, rb.minLng),
          minLat: Math.min(acc.minLat, rb.minLat),
          maxLng: Math.max(acc.maxLng, rb.maxLng),
          maxLat: Math.max(acc.maxLat, rb.maxLat),
        }
      : rb;
  }
  return acc;
}

/**
 * Return the designated OZ tracts whose geometry bounding box overlaps the
 * requested viewport bbox. Deterministic bbox-overlap test against authoritative
 * federal geometry — no synthetic geometry, no external network call.
 */
export function ozTractsInBbox(bbox: OzBboxEnvelope): OzTractFeature[] {
  const collection = loadOzTractFixture();
  const hits: OzTractFeature[] = [];
  for (const feature of collection.features) {
    const gb = geometryBbox(feature.geometry);
    if (!gb) continue;
    const overlaps =
      gb.minLng <= bbox.eastLng &&
      gb.maxLng >= bbox.westLng &&
      gb.minLat <= bbox.northLat &&
      gb.maxLat >= bbox.southLat;
    if (overlaps) hits.push(feature);
  }
  return hits;
}

export const opportunityZoneAdapter: Adapter = {
  adapterKey: "national:opportunity-zone",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "opportunity-zone",
  provider: "CDFI Fund / HUD (OZ tracts)",
  jurisdictionGate: {},
  timeoutMs: 5_000,
  appliesTo: () => true,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const result = lookupOpportunityZone({
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
    });

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "opportunity-zone",
        ...result,
        disclaimer:
          "OZ designation is informational; capital-gains deferral rules depend on hold period and round — verify with a tax advisor.",
      },
    };
  },
};

export function __resetOzTractCacheForTests(): void {
  cachedTracts = null;
  cachedCoverageEnvelope = undefined;
}
