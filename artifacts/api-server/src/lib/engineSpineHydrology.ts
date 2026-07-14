/**
 * Hydrology / topography spine delegation (C3 BFF).
 *
 * DEM fetch, drainage worker, and rainfall forcing unconditionally call
 * engine-api /v1/hydrology/* through the gate-front seam.
 *
 * Envelope note: engine-api seals every /v1 response in the uniform
 * EngineEnvelope (`{ payload, confidence, dataVintage, coverage,
 * source }`) since the gate-front seam seal. These routes MUST unwrap
 * via {@link unwrapSpineResponse} — reading fields off the raw body
 * silently yields `undefined` (the exact failure mode that rendered
 * drainage "not-run" forever in production). `unwrapSpineResponse`
 * also tolerates a bare legacy payload, so a pre-envelope engine-api
 * keeps working.
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
import { unwrapSpineResponse } from "./engineSpineEnvelope";

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

  const raw = await postEngineSpine<unknown>({
    path: "/v1/hydrology/dem",
    body: {
      bbox,
      resolutionMeters: opts.resolutionMeters,
    },
    gateFront,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });

  const { payload } = unwrapSpineResponse<{
    widthPx: number;
    heightPx: number;
    bbox: BboxWgs84;
    demBytesBase64: string;
  }>(raw, { fallbackSource: "usgs:3dep-dem" });

  if (typeof payload?.demBytesBase64 !== "string") {
    throw new Error(
      "engine-api /v1/hydrology/dem response carried no demBytesBase64 payload",
    );
  }

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
  const raw = await postEngineSpine<unknown>({
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

  const { payload } = unwrapSpineResponse<
    | HydrologyWorkerResult
    | { status: "error"; error?: { code?: string; message?: string } }
  >(raw, { fallbackSource: "hydrology:drainage" });

  // Engine worker-error responses nest the failure as
  // `{ status: "error", error: { code, message } }`; flatten to the
  // HydrologyWorkerResult error contract this BFF's ingest consumes.
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { status?: unknown }).status === "error"
  ) {
    const nested = (payload as { error?: { code?: string; message?: string } })
      .error;
    const flat = payload as { code?: string; message?: string };
    return {
      status: "error",
      code: nested?.code ?? flat.code ?? "engine-worker-error",
      message:
        nested?.message ?? flat.message ?? "engine-api hydrology worker failed",
    };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { status?: unknown }).status !== "ok"
  ) {
    return {
      status: "error",
      code: "engine-invalid-response",
      message:
        "engine-api /v1/hydrology/drainage returned an unrecognized payload shape",
    };
  }

  return rehydrateSpineHydrologyWorkerResult(payload as HydrologyWorkerResult);
}

export async function routeResolveRainfallForcing(
  input: ResolveRainfallForcingInput,
  ctx: SpineHydrologyContext,
): Promise<RainfallForcingSource> {
  const gateFront = buildSpineGateFrontContextFromTenant({
    packageId: "hydrology",
    jurisdictionTenant: ctx.jurisdictionTenant,
  });

  const raw = await postEngineSpine<unknown>({
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

  const { payload } = unwrapSpineResponse<RainfallForcingSource>(raw, {
    fallbackSource: "rainfall-forcing",
  });

  // The engine's rainfall route degrades to `{ status: "empty", message }`
  // when the upstream Atlas-14 fetch fails; surface it as a typed throw so
  // the ingest maps it to an honest upstream-error instead of persisting a
  // forcing record with no `kind`.
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { kind?: unknown }).kind !== "string"
  ) {
    const message =
      payload && typeof payload === "object"
        ? String((payload as { message?: unknown }).message ?? "")
        : "";
    throw new Error(
      `engine-api rainfall-forcing returned no forcing source${message ? `: ${message}` : ""}`,
    );
  }

  return rehydrateSpineRainfallForcingSource(payload);
}
