/**
 * Hydrology / topography spine delegation (C3 BFF).
 *
 * DEM fetch, drainage worker, and rainfall forcing unconditionally call
 * engine-api /v1/hydrology/* through the gate-front seam.
 */

import type { BboxWgs84 } from "@workspace/site-context/server";
import type {
  FetchUsgs3depDemOptions,
  FetchUsgs3depDemResult,
  HydrologyWorkerRequest,
  HydrologyWorkerResult,
  ResolveRainfallForcingInput,
  RainfallForcingSource,
} from "@workspace/site-context/server";
import {
  buildSpineGateFrontContextFromTenant,
  postEngineSpine,
} from "./engineSpineClient";
import {
  rehydrateSpineFetchUsgs3depDemResult,
  rehydrateSpineHydrologyWorkerResult,
  rehydrateSpineRainfallForcingSource,
} from "./engineSpineDeserialize";

export interface SpineHydrologyContext {
  jurisdictionTenant: string | null;
}

export async function routeFetchUsgs3depDem(
  bbox: BboxWgs84,
  opts: FetchUsgs3depDemOptions,
  ctx: SpineHydrologyContext,
): Promise<FetchUsgs3depDemResult> {
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
  return rehydrateSpineFetchUsgs3depDemResult({
    bytes: new Uint8Array(bytes),
    contentType: "image/tiff",
    bbox: payload.bbox,
    resolutionMeters: opts.resolutionMeters,
    widthPx: payload.widthPx,
    heightPx: payload.heightPx,
    endpoint: "spine:/v1/hydrology/dem",
    fetchedAt,
  });
}

export async function routeRunHydrologyWorker(
  req: HydrologyWorkerRequest,
  ctx: SpineHydrologyContext,
): Promise<HydrologyWorkerResult> {
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

  return rehydrateSpineHydrologyWorkerResult(payload);
}

export async function routeResolveRainfallForcing(
  input: ResolveRainfallForcingInput,
  ctx: SpineHydrologyContext,
): Promise<RainfallForcingSource> {
  const gateFront = buildSpineGateFrontContextFromTenant({
    packageId: "hydrology",
    jurisdictionTenant: ctx.jurisdictionTenant,
  });

  const payload = await postEngineSpine<RainfallForcingSource>({
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

  return rehydrateSpineRainfallForcingSource(payload);
}
