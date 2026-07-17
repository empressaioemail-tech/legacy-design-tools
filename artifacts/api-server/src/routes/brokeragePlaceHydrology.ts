/**
 * Place-scoped site-topography and site-drainage routes for MCP callers.
 *
 *   POST /api/brokerage/v1/place/site-topography/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography
 *   POST /api/brokerage/v1/place/:placeKey/site-topography/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography/mesh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography/ifc
 *   POST /api/brokerage/v1/place/site-drainage/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-drainage
 *   POST /api/brokerage/v1/place/:placeKey/site-drainage/refresh
 *
 * Address-only callers POST to the `/place/site-*` paths with `{ address }`.
 * Callers with a placeKey from `resolve_place` use the `:placeKey` paths.
 * Internally resolves to a deterministic MCP place engagement and reuses
 * the engagement-scoped ingest workers.
 *
 * ARTIFACT RETRIEVAL (mesh / ifc) — the two `.../mesh` and `.../ifc` reads are
 * the authorized way to fetch the terrain object bytes. They are engagement-
 * scoped BY CONSTRUCTION: the caller supplies only a placeKey (address-plane),
 * the route resolves it to THIS engagement under the caller's gate/jurisdiction
 * tenant (same resolution the sibling `GET :placeKey/site-topography` metadata
 * read uses), then derives the object path from THAT engagement's materialized
 * read model (`propertySet.meshRef` / `propertySet.ifcRef`) and serves only that
 * object. The caller can never pass a raw object UUID, so the pre-existing
 * "any /objects/uploads/<uuid> to any anonymous caller" hole on the ungated
 * `GET /storage/objects/*` route is closed here by construction — this route
 * derives the path server-side and inherits the brokerage gate (401 on a
 * missing/bad key via `requireBrokerageAuthOrServiceToken` on the parent
 * `brokerageV1` router).
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { Readable } from "stream";
import { z } from "zod";
import { logger } from "../lib/logger";
import { resolveRequestJurisdictionTenant } from "../lib/gateFrontSeam";
import { getHistoryService } from "../atoms/registry";
import { ensureMcpPlaceEngagement } from "../lib/mcpPlaceEngagement";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
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

const terrainObjectStorage = new ObjectStorageService();

const PLACE_KEY_PARAM = z.string().min(1);

/**
 * The terrain artifact kinds a caller can retrieve, mapped to the read-model
 * `propertySet` key that holds the object path and the wire content-type.
 *
 * GLB objects are uploaded to storage as `application/octet-stream` (the DEM
 * mesh authoring path writes them without a glTF MIME), so we override the
 * content-type on the way out rather than trusting the stored metadata — a
 * 3D viewer / the Brief download needs `model/gltf-binary` to treat the bytes
 * as a GLB.
 */
const TERRAIN_ARTIFACTS = {
  mesh: {
    refKey: "meshRef",
    contentType: "model/gltf-binary",
    filename: "site-topography.glb",
  },
  ifc: {
    refKey: "ifcRef",
    // No registered IANA type for IFC; `application/octet-stream` is the safe
    // download default and matches how the object was stored.
    contentType: "application/octet-stream",
    filename: "site-topography.ifc",
  },
} as const;

type TerrainArtifactKind = keyof typeof TERRAIN_ARTIFACTS;

/**
 * Pure resolver: given a materialized site-topography `propertySet` and an
 * artifact kind, return the object-storage path for that artifact, or null
 * when the read model doesn't carry one (pre-mesh/pre-ifc payload, or authoring
 * skipped/failed). Kept pure so the authorization/derivation logic is unit-
 * testable without a DB or object store.
 *
 * The returned path is ALWAYS taken from the engagement's own read model — it
 * is never influenced by caller input beyond the placeKey that resolved the
 * engagement. This is the property that closes the arbitrary-UUID hole.
 */
export function resolveTerrainArtifactPath(
  propertySet: Record<string, unknown> | null | undefined,
  kind: TerrainArtifactKind,
): string | null {
  if (!propertySet || typeof propertySet !== "object") return null;
  const raw = propertySet[TERRAIN_ARTIFACTS[kind].refKey];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Only ever serve an object we minted into the private object dir. A ref that
  // is not an `/objects/...` entity path is not servable through this route.
  if (!trimmed.startsWith("/objects/")) return null;
  return trimmed;
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

/**
 * Stream a terrain artifact (mesh GLB or IFC) for a place.
 *
 * Authorization is engagement-scoped by construction:
 *   1. The caller is already past the brokerage gate (parent router applies
 *      `requireBrokerageAuthOrServiceToken`; a missing/bad key never reaches
 *      this handler — it is 401'd upstream).
 *   2. We resolve the placeKey to a deterministic engagement under the caller's
 *      jurisdiction tenant — the SAME resolution the metadata read uses.
 *   3. We load THAT engagement's materialized site-topography row and read the
 *      object path off its `propertySet` (`meshRef` / `ifcRef`). The caller
 *      supplies no object path/UUID; it is derived server-side.
 *   4. We stream only that derived object.
 *
 * A caller therefore cannot retrieve an object outside the engagement their
 * placeKey resolves to, and cannot address an arbitrary object by UUID.
 */
async function handleArtifactRead(
  req: Request,
  res: Response,
  placeKeyParam: string,
  kind: TerrainArtifactKind,
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

  // Load the authorized engagement's active read model. Replay-from-events
  // recovers a row whose read model was dropped, exactly as the metadata read
  // does — so a completed run that lost its cached row still serves.
  let row = await loadActiveSiteTopographyRow(ensured.engagementId);
  if (!row) {
    const replayed = await rematerializeFromLatestEvent({
      history: getHistoryService(),
      engagementId: ensured.engagementId,
      log,
    }).catch(() => ({ status: "no-event" as const, reason: "replay failed" }));
    if (replayed.status === "ok") {
      row = await loadActiveSiteTopographyRow(ensured.engagementId);
    }
  }

  // Derive the object path from THIS engagement's read model. Never from the
  // caller. Honest 404 when the artifact isn't materialized yet (job pending,
  // no coverage, or an older payload that predates mesh/ifc authoring).
  const objectPath = resolveTerrainArtifactPath(row?.propertySet, kind);
  if (!objectPath) {
    res.status(404).json({
      status: "not-found",
      reason:
        `No ${kind} artifact for this place yet; POST …/site-topography/refresh ` +
        `and poll GET …/site-topography until jobStatus is "ready".`,
    });
    return;
  }

  const spec = TERRAIN_ARTIFACTS[kind];
  try {
    const objectFile = await terrainObjectStorage.getObjectEntityFile(objectPath);
    const response = await terrainObjectStorage.downloadObject(objectFile);

    res.status(response.status);
    // Preserve storage headers (Content-Length, Cache-Control: private, ...)
    // but force the correct artifact content-type and mark it a download.
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-type") return;
      res.setHeader(key, value);
    });
    res.setHeader("Content-Type", spec.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${spec.filename}"`,
    );

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      // The read model referenced an object that no longer exists in storage.
      // Honest 404 rather than a 500 — the artifact is effectively gone.
      log.warn(
        { engagementId: ensured.engagementId, kind, objectPath },
        "terrain artifact object missing in storage",
      );
      res.status(404).json({
        status: "not-found",
        reason: `The ${kind} artifact for this place is no longer available.`,
      });
      return;
    }
    log.error(
      { err, engagementId: ensured.engagementId, kind },
      "terrain artifact serve failed",
    );
    res.status(500).json({
      status: "error",
      reason: "Failed to serve terrain artifact.",
    });
  }
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

// Gated, engagement-scoped artifact retrieval. These sit behind the SAME
// brokerage gate as the metadata read above (parent `brokerageV1` applies
// `requireBrokerageAuthOrServiceToken`), and derive the object path from the
// resolved engagement's read model — never from caller-supplied input.
brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-topography/mesh",
  (req, res) =>
    void handleArtifactRead(
      req,
      res,
      decodePlaceKeyParam(req.params.placeKey),
      "mesh",
    ),
);

brokeragePlaceHydrologyRouter.get(
  "/:placeKey/site-topography/ifc",
  (req, res) =>
    void handleArtifactRead(
      req,
      res,
      decodePlaceKeyParam(req.params.placeKey),
      "ifc",
    ),
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
