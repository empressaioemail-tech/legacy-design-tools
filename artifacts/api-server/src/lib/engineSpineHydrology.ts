/**
 * Hydrology / topography spine delegation (C1).
 *
 * When ENGINE_SPINE_HYDROLOGY or ENGINE_SPINE_TOPOGRAPHY flags are on,
 * DEM fetch, drainage worker, and rainfall forcing call engine-api /v1/hydrology/*
 * instead of local @workspace/site-context adapters.
 */

import type { BboxWgs84 } from "@workspace/site-context/server";
import {
  fetchUsgs3depDem,
  runHydrologyWorker,
  resolveRainfallForcing,
  type FetchUsgs3depDemOptions,
  type FetchUsgs3depDemResult,
  type HydrologyWorkerRequest,
  type HydrologyWorkerResult,
  type ResolveRainfallForcingInput,
  type RainfallForcingSource,
} from "@workspace/site-context/server";
import {
  buildSpineGateFrontContextFromTenant,
  postEngineSpine,
} from "./engineSpineClient";
import { useSpineHydrology, useSpineTopography } from "./engineSpineFlags";

export interface SpineHydrologyContext {
  jurisdictionTenant: string | null;
}

export async function routeFetchUsgs3depDem(
  bbox: BboxWgs84,
  opts: FetchUsgs3depDemOptions,
  ctx: SpineHydrologyContext,
): Promise<FetchUsgs3depDemResult> {
  if (!useSpineTopography()) {
    return fetchUsgs3depDem(bbox, opts);
  }

  const gateFront = buildSpineGateFrontContextFromTenant({
    packageId: "hydrology",
    jurisdictionTenant: ctx.jurisdictionTenant,
  });

  const payload = await postEngineSpine<{
    widthPx: number;
    heightPx: number;
    bbox: BboxWgs84;
    demBytesBase64: string;
  }>({
    path: "/v1/hydrology/dem",
    body: {
      bbox,
      resolutionMeters: opts.resolutionMeters,
    },
    gateFront,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });

  const bytes = Buffer.from(payload.demBytesBase64, "base64");
  const fetchedAt = new Date().toISOString();
  return {
    bytes: new Uint8Array(bytes),
    contentType: "image/tiff",
    bbox: payload.bbox,
    resolutionMeters: opts.resolutionMeters,
    widthPx: payload.widthPx,
    heightPx: payload.heightPx,
    endpoint: "spine:/v1/hydrology/dem",
    fetchedAt,
  };
}

export async function routeRunHydrologyWorker(
  req: HydrologyWorkerRequest,
  ctx: SpineHydrologyContext,
): Promise<HydrologyWorkerResult> {
  if (!useSpineHydrology()) {
    return runHydrologyWorker(req);
  }

  const gateFront = buildSpineGateFrontContextFromTenant({
    packageId: "hydrology",
    jurisdictionTenant: ctx.jurisdictionTenant,
  });

  const demBytes = Buffer.from(req.demBytes);
  const payload = await postEngineSpine<HydrologyWorkerResult>({
    path: "/v1/hydrology/drainage",
    body: {
      demBytesBase64: demBytes.toString("base64"),
      pourLng: req.pourLng,
      pourLat: req.pourLat,
      catchmentBbox: req.catchmentBbox,
      width: req.width,
      height: req.height,
      rainfallDepthMm: req.rainfallDepthMm,
      accumulationThreshold: req.accumulationThreshold,
    },
    gateFront,
    timeoutMs: 180_000,
  });

  return payload;
}

export async function routeResolveRainfallForcing(
  input: ResolveRainfallForcingInput,
  ctx: SpineHydrologyContext,
): Promise<RainfallForcingSource> {
  if (!useSpineHydrology()) {
    return resolveRainfallForcing(input);
  }

  const gateFront = buildSpineGateFrontContextFromTenant({
    packageId: "hydrology",
    jurisdictionTenant: ctx.jurisdictionTenant,
  });

  return postEngineSpine<RainfallForcingSource>({
    path: "/v1/hydrology/rainfall-forcing",
    body: {
      latitude: input.lat,
      longitude: input.lng,
      manualDepthMm:
        input.manualDepthInches !== undefined
          ? input.manualDepthInches * 25.4
          : undefined,
    },
    gateFront,
  });
}
