/**
 * Place-scoped site-topography and site-drainage routes for MCP callers.
 *
 *   POST /api/brokerage/v1/place/site-topography/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-topography
 *   POST /api/brokerage/v1/place/:placeKey/site-topography/refresh
 *   POST /api/brokerage/v1/place/site-drainage/refresh
 *   GET  /api/brokerage/v1/place/:placeKey/site-drainage
 *   POST /api/brokerage/v1/place/:placeKey/site-drainage/refresh
 *
 * Address-only callers POST to the `/place/site-*` paths with `{ address }`.
 * Callers with a placeKey from `resolve_place` use the `:placeKey` paths.
 * Internally resolves to a deterministic MCP place engagement and reuses
 * the engagement-scoped ingest workers.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import { ensureMcpPlaceEngagement } from "../lib/mcpPlaceEngagement";
import {
  ingestSiteTopography,
  type SiteTopographyIngestResult,
} from "../lib/siteTopographyIngest";
import {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
} from "../lib/siteTopographyMaterializer";
import { ingestResultToHttp } from "./siteTopography";
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

  const ensured = await ensureMcpPlaceEngagement(input);
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);
  let result: SiteTopographyIngestResult;
  try {
    result = await ingestSiteTopography({
      engagementId: ensured.engagementId,
      history: getHistoryService(),
      contourIntervalMeters: parsed.data.contourIntervalMeters,
      catchmentBufferMeters: parsed.data.catchmentBufferMeters,
      demResolutionMeters: parsed.data.demResolutionMeters,
      forceRefresh: parsed.data.forceRefresh,
      log,
    });
  } catch (err) {
    log.error({ err, engagementId: ensured.engagementId }, "place site-topography refresh failed");
    res.status(500).json({
      error: "internal_worker_error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { status, body } = ingestResultToHttp(result);
  res.status(status).json(
    withPlaceEnvelope(body, {
      placeKey: ensured.placeKey,
      engagementId: ensured.engagementId,
      created: ensured.created,
    }),
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
  });
  if (!ensured.ok) {
    res.status(ensured.status).json(ensured.body);
    return;
  }

  const log = reqLog(req);
  let row = await loadActiveSiteTopographyRow(ensured.engagementId);
  if (!row) {
    const replayed = await rematerializeFromLatestEvent({
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
    row = await loadActiveSiteTopographyRow(ensured.engagementId);
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

  const ensured = await ensureMcpPlaceEngagement(input);
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
