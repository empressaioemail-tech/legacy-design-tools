/**
 * Map-layers spine routing — gate-fronted POST /v1/map-layers/assemble.
 */

import type { Request } from "express";
import {
  buildSpineGateFrontContext,
  buildSpineGateFrontContextFromTenant,
  postEngineSpine,
  type SpineGateFrontContext,
} from "./engineSpineClient";
import { unwrapSpineResponse } from "./engineSpineEnvelope";
import type { EngineHonesty } from "@workspace/engine-core";

export const MAP_LAYER_KEYS = [
  "parcel-polygon",
  "flood-zone",
  "floodway",
  "dem",
  "topography",
  "opportunity-zone-tract",
  "zoning",
] as const;

export type MapLayerKey = (typeof MAP_LAYER_KEYS)[number];

export interface MapLayersBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface MapLayersAssembleRequest {
  parcel: {
    latitude: number;
    longitude: number;
    address?: string | null;
    parcelKey?: string;
  };
  jurisdiction: {
    stateKey: "utah" | "idaho" | "texas" | null;
    localKey: "grand-county-ut" | "lemhi-county-id" | "bastrop-tx" | null;
    partnerCity?: boolean;
  };
  layers?: MapLayerKey[];
  forceRefresh?: boolean;
  bbox?: MapLayersBbox;
}

export interface MapLayerSlot {
  layerKey: MapLayerKey;
  status: "ok" | "pending" | "no-coverage" | "failed";
  adapterKey?: string;
  pendingReason?: string;
  envelope: {
    payload: Record<string, unknown>;
    confidence: { value: number; kind: string };
    dataVintage: string | null;
    coverage: { degraded: boolean; reason?: string };
    source: { adapter: string; citationIds?: string[] };
  } | null;
  error?: { code: string; message: string };
}

export interface MapLayersAssemblePayload {
  parcelKey: string;
  place: {
    latitude: number;
    longitude: number;
    formattedAddress?: string | null;
  };
  tenantScope: string;
  layers: MapLayerSlot[];
  assembledAt: string;
}

export interface SpineRoutedMapLayersResult {
  payload: MapLayersAssemblePayload;
  honesty: EngineHonesty;
}

export interface MapLayersRoutingContext {
  jurisdictionTenant: string | null;
  subjectId?: string;
  /** Max map render uses public-paid at the gate. */
  accessTier?: SpineGateFrontContext["accessTier"];
}

function resolveGateFront(
  req: Request | null,
  ctx: MapLayersRoutingContext,
): SpineGateFrontContext {
  const packageId = "map-layers" as const;
  if (req) {
    return buildSpineGateFrontContext(req, {
      packageId,
      jurisdictionTenant: ctx.jurisdictionTenant,
      accessTier: ctx.accessTier ?? "public-paid",
    });
  }
  return buildSpineGateFrontContextFromTenant({
    packageId,
    jurisdictionTenant: ctx.jurisdictionTenant,
    subjectId: ctx.subjectId,
    accessTier: ctx.accessTier ?? "public-paid",
  });
}

export async function routeAssembleMapLayers(
  body: MapLayersAssembleRequest,
  ctx: MapLayersRoutingContext,
  req: Request | null = null,
): Promise<SpineRoutedMapLayersResult> {
  const gateFront = resolveGateFront(req, ctx);

  const raw = await postEngineSpine<unknown>({
    path: "/v1/map-layers/assemble",
    body,
    gateFront,
    timeoutMs: 120_000,
  });

  const { payload, honesty } = unwrapSpineResponse<MapLayersAssemblePayload>(
    raw,
    { fallbackSource: "map-layers:assemble" },
  );

  return { payload, honesty };
}

/** Adapter keys assembled by the spine — skip duplicate fan-out in generate-layers. */
export const MAP_LAYERS_DEDUPED_ADAPTER_KEYS = new Set([
  "cotality:parcels",
  "fema:nfhl-flood-zone",
  "cotality:zoning",
]);

export function defaultCatchmentBbox(
  latitude: number,
  longitude: number,
  bufferDeg = 0.002,
): MapLayersBbox {
  return {
    westLng: longitude - bufferDeg,
    southLat: latitude - bufferDeg,
    eastLng: longitude + bufferDeg,
    northLat: latitude + bufferDeg,
  };
}
