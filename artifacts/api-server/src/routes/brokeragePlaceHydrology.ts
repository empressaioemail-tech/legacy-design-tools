/**
 * Place-scoped site-topography and site-drainage routes for MCP callers.
 *
 *   POST /api/brokerage/v1/place/site-topography/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography
 *   POST /api/brokerage/v1/place/:placeKey/site-topography/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography/mesh  (410 Gone — retired)
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography/ifc   (410 Gone — retired)
 *   POST /api/brokerage/v1/place/site-drainage/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-drainage
 *   POST /api/brokerage/v1/place/:placeKey/site-drainage/refresh
 *
 * Address-only callers POST to the `/place/site-*` paths with `{ address }`.
 * Callers with a placeKey from `resolve_place` use the `:placeKey` paths.
 * Internally resolves to a deterministic MCP place engagement and reuses
 * the engagement-scoped ingest workers.
 *
 * ARTIFACT RETRIEVAL (mesh / ifc) — RETIRED (WDLL item 7 / I-A). The legacy
 * cortex mesh/IFC authoring path is gone; callers must use spine
 * `refresh_parcel_terrain_export` for terrain deliverables. The two GET routes
 * remain registered but return 410 Gone with a pointer message.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { resolveRequestJurisdictionTenant } from "../lib/gateFrontSeam";
import { getHistoryService } from "../atoms/registry";
import { ensureMcpPlaceEngagement } from "../lib/mcpPlaceEngagement";
import {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
} from "../lib/siteTopographyMaterializer";
import {
  enqueueTerrainJob,
  loadActiveTerrainJob,
  loadLatestTerrainJob,
} from "../lib/terrainJobWorker";
import {
  ingestSiteDrainage,
  type SiteDrainageIngestResult,
} from "../lib/siteDrainageIngest";
import {
  loadActiveSiteDrainageRow,
  rematerializeSiteDrainageFromLatestEvent,
} from "../lib/siteDrainageMaterializer";
import { ingestDrainageResultToHttp } from "./siteDrainage";

export const brokeragePlaceHydrologyRouter: IRouter = Router();

const PLACE_KEY_PARAM = z.string().min(1);

const RETIRED_TERRAIN_ARTIFACT_MESSAGE =
  "Cortex terrain mesh/IFC authoring retired. Use spine refresh_parcel_terrain_export for terrain deliverables.";

function handleRetiredTerrainArtifact(_req: Request, res: Response): void {
  res.status(410).json({
    status: "gone",
    reason: RETIRED_TERRAIN_ARTIFACT_MESSAGE,
    replacement: "refresh_parcel_terrain_export",
  });
}

const TOPO_REFRESH_BODY = z
  .object({
    address: z.string().min(1).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    contourIntervalMeters: z.number().positive().max(100).optional(),
    catchmentBufferMeters: z.number().nonnegative().max(5000).optional(),
    demResolutionMeters: z.number().positive().max(100).optional(),
    forceRefresh: z.boolean().optional(),
  })
  .strict();

const DRAINAGE_REFRESH_BODY = z
  .object({
    address: z.string().min(1).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    manualDepthInches: z.number().positive().max(50).optional(),
    returnPeriodYears: z.number().int().positive().max(500).optional(),
    accumulationThreshold: z.number().int().positive().max(10_000).optional(),
    forceRefresh: z.boolean().optional(),
    useCotalityForcing: z.boolean().optional(),
  })
  .strict();

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

function decodePlaceKeyParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return decodeURIComponent(value ?? "").trim();
}

function placeEngagementInputFromRefreshBody(
  body: z.infer<typeof TOPO_REFRESH_BODY> | z.infer<typeof DRAINAGE_REFRESH_BODY>,
  placeKey?: string,
) {
  if (placeKey) {
    return {
      placeKey,
      address: body.address,
    } as const;
  }
  if (body.address) {
    return { address: body.address } as const;
  }
  if (body.lat != null && body.lng != null) {
    return { lat: body.lat, lng: body.lng, address: body.address } as const;
  }
  return null;
}

function withPlaceEnvelope<T extends Record<string, unknown>>(
  body: T,
  place: { placeKey: string; engagementId: string; created: boolean },
): T & {
  placeKey: string;
  engagementId: string;
  mcpPlaceEngagementCreated: boolean;
} {
  return {
    ...body,
    placeKey: place.placeKey,
    engagementId: place.engagementId,
    mcpPlaceEngagementCreated: place.created,
  };
}

async function handleTopoRefresh(
  req: Request,
  res: Response,
  placeKeyParam?: string,
): Promise<void> {
  const parsed = TOPO_REFRESH_BODY.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }

  const input = placeEngagementInputFromRefreshBody(parsed.data, placeKeyParam);
  if (!input) {
    res.status(400).json({
      error: "invalid_request",
      message: "address, lat/lng, or placeKey required",
    });
    return;
  }

  const ensured = await ensureMcpPlaceEngagement({
    ...input,
    jurisdictionTenant: resolveRequestJurisdictionTenant(req),
  });
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);

  // ASYNC: enqueue the terrain job and return 202 immediately. The heavy
  // DEM -> mesh -> IFC authoring runs OFF the request path in a fire-and-forget
  // worker (terrainJobWorker), which builds the mesh on a worker thread. This
  // is the fix for the 503s: the synchronous authoring on the shared 2-CPU
  // container pegged both cores and starved the co-scheduled 29s brief request.
  // The client polls GET :placeKey/site-topography for the terminal state.
  let enqueued: Awaited<ReturnType<typeof enqueueTerrainJob>>;
  try {
    enqueued = await enqueueTerrainJob({
      engagementId: ensured.engagementId,
      placeKey: ensured.placeKey,
      params: {
        jurisdictionTenant: resolveRequestJurisdictionTenant(req),
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        catchmentBufferMeters: parsed.data.catchmentBufferMeters,
        demResolutionMeters: parsed.data.demResolutionMeters,
        forceRefresh: parsed.data.forceRefresh,
      },
      log,
    });
  } catch (err) {
    log.error(
      { err, engagementId: ensured.engagementId },
      "place site-topography refresh: enqueue failed",
    );
    res.status(500).json({
      error: "internal_worker_error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 202 Accepted — authoring is in progress (or already in flight). The read
  // route reports pending -> ready/failed. Envelope stays place-shaped so the
  // Brief keeps reading `placeKey` off the response.
  res.status(202).json(
    withPlaceEnvelope(
      {
        status: enqueued.alreadyInFlight ? "in-progress" : "accepted",
        jobId: enqueued.jobId,
        jobStatus: enqueued.alreadyInFlight ? "generating" : "queued",
      },
      {
        placeKey: ensured.placeKey,
        engagementId: ensured.engagementId,
        created: ensured.created,
      },
    ),
  );
}

async function handleTopoRead(
  req: Request,
  res: Response,
  placeKeyParam: string,
): Promise<void> {
  const placeKeyParse = PLACE_KEY_PARAM.safeParse(placeKeyParam);
  if (!placeKeyParse.success) {
    res.status(400).json({ error: "invalid_request", message: "placeKey required" });
    return;
  }

  const ensured = await ensureMcpPlaceEngagement({
    placeKey: placeKeyParse.data,
    jurisdictionTenant: resolveRequestJurisdictionTenant(req),
  });
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);

  // ASYNC status read. The Brief polls this after a 202 from the refresh route.
  // Report the terrain job's lifecycle:
  //   pending      an authoring job is queued/generating (poll again)
  //   ready        the materialized site-topography row is present (return it)
  //   no-coverage  the parcel has no derivable extent (terminal, honest)
  //   failed       authoring failed (terminal, honest)
  //   not-found    nothing has ever been requested for this place
  //
  // A ready result is reported the moment the materialized row exists — that is
  // the source of truth, so a `ready` render also covers the (backward-compat)
  // case of a row produced before this async path existed. We check the row
  // FIRST so a completed run always reads as ready even if its job row was
  // reaped by the sweep.
  let row = await loadActiveSiteTopographyRow(ensured.engagementId);
  if (!row) {
    // Replay-from-events recovers a row whose read model was dropped. Treat a
    // replay error as transient rather than terminal (don't mask an in-flight
    // job); a `no-event` just means no successful run has landed yet.
    const replayed = await rematerializeFromLatestEvent({
      history: getHistoryService(),
      engagementId: ensured.engagementId,
      log,
    }).catch(() => ({ status: "no-event" as const, reason: "replay failed" }));
    if (replayed.status === "ok") {
      row = await loadActiveSiteTopographyRow(ensured.engagementId);
    }
  }

  if (row) {
    res.status(200).json(
      withPlaceEnvelope(
        {
          // `status: "ok"` preserved for backward compatibility with the
          // pre-async read contract; `jobStatus: "ready"` is the async signal.
          status: "ok",
          jobStatus: "ready",
          materializableElementId: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          propertySet: row.propertySet,
        },
        {
          placeKey: ensured.placeKey,
          engagementId: ensured.engagementId,
          created: ensured.created,
        },
      ),
    );
    return;
  }

  // No materialized row yet — report the job lifecycle so the poller knows
  // whether to keep polling (pending) or stop (failed / no-coverage / none).
  const activeJob = await loadActiveTerrainJob(ensured.engagementId);
  if (activeJob) {
    res.status(200).json(
      withPlaceEnvelope(
        { status: "pending", jobStatus: "pending", jobId: activeJob.id },
        {
          placeKey: ensured.placeKey,
          engagementId: ensured.engagementId,
          created: ensured.created,
        },
      ),
    );
    return;
  }

  const latestJob = await loadLatestTerrainJob(ensured.engagementId);
  if (latestJob && latestJob.status === "no-coverage") {
    res.status(200).json(
      withPlaceEnvelope(
        {
          status: "no-coverage",
          jobStatus: "no-coverage",
          jobId: latestJob.id,
          reason:
            latestJob.errorMessage ??
            "No parcel coverage here yet, so a terrain model can't be built.",
        },
        {
          placeKey: ensured.placeKey,
          engagementId: ensured.engagementId,
          created: ensured.created,
        },
      ),
    );
    return;
  }
  if (latestJob && latestJob.status === "failed") {
    res.status(200).json(
      withPlaceEnvelope(
        {
          status: "failed",
          jobStatus: "failed",
          jobId: latestJob.id,
          code: latestJob.errorCode ?? "internal_worker_error",
          reason: latestJob.errorMessage ?? "Terrain authoring failed.",
        },
        {
          placeKey: ensured.placeKey,
          engagementId: ensured.engagementId,
          created: ensured.created,
        },
      ),
    );
    return;
  }

  // Nothing requested (or the row-and-job both absent). 404 preserves the
  // pre-async "no topo yet" contract.
  res.status(404).json(
    withPlaceEnvelope(
      {
        status: "not-found",
        jobStatus: "none",
        reason:
          "No terrain model for this place yet; POST …/site-topography/refresh to start one.",
      },
      {
        placeKey: ensured.placeKey,
        engagementId: ensured.engagementId,
        created: ensured.created,
      },
    ),
  );
}

async function handleDrainageRefresh(
  req: Request,
  res: Response,
  placeKeyParam?: string,
): Promise<void> {
  const parsed = DRAINAGE_REFRESH_BODY.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }

  const input = placeEngagementInputFromRefreshBody(parsed.data, placeKeyParam);
  if (!input) {
    res.status(400).json({
      error: "invalid_request",
      message: "address, lat/lng, or placeKey required",
    });
    return;
  }

  const ensured = await ensureMcpPlaceEngagement({
    ...input,
    jurisdictionTenant: resolveRequestJurisdictionTenant(req),
  });
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);
  let result: SiteDrainageIngestResult;
  try {
    result = await ingestSiteDrainage({
      engagementId: ensured.engagementId,
      history: getHistoryService(),
      manualDepthInches: parsed.data.manualDepthInches,
      returnPeriodYears: parsed.data.returnPeriodYears,
      accumulationThreshold: parsed.data.accumulationThreshold,
      forceRefresh: parsed.data.forceRefresh,
      useCotalityForcing: parsed.data.useCotalityForcing,
      log,
    });
  } catch (err) {
    log.error({ err, engagementId: ensured.engagementId }, "place site-drainage refresh failed");
    res.status(500).json({
      error: "internal_worker_error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { status, body } = ingestDrainageResultToHttp(result);
  res.status(status).json(
    withPlaceEnvelope(body, {
      placeKey: ensured.placeKey,
      engagementId: ensured.engagementId,
      created: ensured.created,
    }),
  );
}

async function handleDrainageRead(
  req: Request,
  res: Response,
  placeKeyParam: string,
): Promise<void> {
  const placeKeyParse = PLACE_KEY_PARAM.safeParse(placeKeyParam);
  if (!placeKeyParse.success) {
    res.status(400).json({ error: "invalid_request", message: "placeKey required" });
    return;
  }

  const ensured = await ensureMcpPlaceEngagement({
    placeKey: placeKeyParse.data,
    jurisdictionTenant: resolveRequestJurisdictionTenant(req),
  });
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);
  let row = await loadActiveSiteDrainageRow(ensured.engagementId);
  if (!row) {
    const replayed = await rematerializeSiteDrainageFromLatestEvent({
      history: getHistoryService(),
      engagementId: ensured.engagementId,
      log,
    });
    if (replayed.status === "no-event") {
      res.status(404).json({ status: "not-found", reason: replayed.reason });
      return;
    }
    if (replayed.status === "error") {
      res.status(500).json({ status: "error", reason: replayed.reason });
      return;
    }
    row = await loadActiveSiteDrainageRow(ensured.engagementId);
  }
  if (!row) {
    res.status(500).json({
      status: "error",
      reason: "Row missing after replay.",
    });
    return;
  }

  res.status(200).json(
    withPlaceEnvelope(
      {
        status: "ok",
        materializableElementId: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        propertySet: row.propertySet,
      },
      {
        placeKey: ensured.placeKey,
        engagementId: ensured.engagementId,
        created: ensured.created,
      },
    ),
  );
}

brokeragePlaceHydrologyRouter.post(
  "/site-topography/refresh",
  (req, res) => void handleTopoRefresh(req, res),
);

brokeragePlaceHydrologyRouter.post(
  "/:placeKey/site-topography/refresh",
  (req, res) =>
    void handleTopoRefresh(req, res, decodePlaceKeyParam(req.params.placeKey)),
);

brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-topography",
  (req, res) =>
    void handleTopoRead(req, res, decodePlaceKeyParam(req.params.placeKey)),
);

brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-topography/mesh",
  handleRetiredTerrainArtifact,
);

brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-topography/ifc",
  handleRetiredTerrainArtifact,
);

brokeragePlaceHydrologyRouter.post(
  "/site-drainage/refresh",
  (req, res) => void handleDrainageRefresh(req, res),
);

brokeragePlaceHydrologyRouter.post(
  "/:placeKey/site-drainage/refresh",
  (req, res) =>
    void handleDrainageRefresh(req, res, decodePlaceKeyParam(req.params.placeKey)),
);

brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-drainage",
  (req, res) =>
    void handleDrainageRead(req, res, decodePlaceKeyParam(req.params.placeKey)),
);
