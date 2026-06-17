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

interface OzTractCollection {
  type: "FeatureCollection";
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
}
