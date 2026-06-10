/**
 * Site-topography routes — Phase 2D.x PR3.
 *
 * Two endpoints:
 *
 *   - `POST /api/engagements/:id/site-topography/refresh`
 *     Triggers the DEM ingest worker. Synchronous within the request
 *     (no background queue — derivation runs ~3-6s for parcel-scale
 *     engagements). Body: `{ contourIntervalMeters?, catchmentBufferMeters?,
 *     demResolutionMeters?, forceRefresh? }` — all optional, defaults
 *     to the values in `siteTopographyIngest.ts`. Returns the worker's
 *     full result envelope.
 *
 *   - `GET /api/engagements/:id/site-topography`
 *     Returns the engagement's active site-topography row's read
 *     model. Falls through to `rematerializeFromLatestEvent` when no
 *     row exists but events do (replay-from-events recovery). Returns
 *     404 when no events exist either (the architect hasn't triggered
 *     the worker yet).
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { requireGateEngineServiceAuth } from "../middlewares/gateEngineServiceAuth";
import { assertEngagementServiceTenantScope } from "../lib/gateFrontSeamEngagement";
import { getHistoryService } from "../atoms/registry";
import {
  ingestSiteTopography,
  type SiteTopographyIngestResult,
} from "../lib/siteTopographyIngest";
import {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
} from "../lib/siteTopographyMaterializer";

const router: IRouter = Router();

router.use(requireGateEngineServiceAuth);

const REFRESH_BODY_SCHEMA = z
  .object({
    contourIntervalMeters: z.number().positive().max(100).optional(),
    catchmentBufferMeters: z.number().nonnegative().max(5000).optional(),
    demResolutionMeters: z.number().positive().max(100).optional(),
    forceRefresh: z.boolean().optional(),
  })
  .strict();

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

/**
 * Mapper from the worker's result envelope to an HTTP status + body.
 * Keeps the route handler one-liner and lets the test suite assert
 * the mapping directly without driving Express.
 */
export function ingestResultToHttp(
  result: SiteTopographyIngestResult,
): { status: number; body: Record<string, unknown> } {
  if (result.status === "ok") {
    return {
      status: 200,
      body: {
        status: "ok",
        atomEventId: result.atomEventId,
        eventType: result.eventType,
        materializableElementId: result.materializableElementId,
        demGcsObjectPath: result.demGcsObjectPath,
        contourCount: result.contourCount,
        contourIntervalMeters: result.contourIntervalMeters,
        demResolutionMeters: result.demResolutionMeters,
        parcelOrigin: result.parcelOrigin,
        parcelBbox: result.parcelBbox,
        catchmentBbox: result.catchmentBbox,
        reusedExisting: result.reusedExisting,
      },
    };
  }
  if (result.status === "no-parcel-coverage") {
    // 422 — the engagement is well-formed but doesn't have what the
    // worker needs (no parcel briefing, no geocode). The architect's
    // remediation is "run Generate Layers first" or "update the
    // engagement address."
    return {
      status: 422,
      body: { status: "no-parcel-coverage", reason: result.reason },
    };
  }
  // upstream-error
  const httpStatus =
    result.code === "usgs3dep-timeout" || result.code === "usgs3dep-aborted"
      ? 504
      : 502;
  return {
    status: httpStatus,
    body: {
      status: "upstream-error",
      code: result.code,
      reason: result.reason,
      ...(result.code === "materializer-failed" && result.diagnosticEventId
        ? { diagnosticEventId: result.diagnosticEventId }
        : {}),
    },
  };
}

router.post(
  "/engagements/:id/site-topography/refresh",
  async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const engagementId = typeof rawId === "string" ? rawId : "";
    if (!engagementId) {
      res.status(400).json({ error: "missing_engagement_id" });
      return;
    }
    const parsed = REFRESH_BODY_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues,
      });
      return;
    }
    const log = reqLog(req);
    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }
    let result: SiteTopographyIngestResult;
    try {
      result = await ingestSiteTopography({
        engagementId,
        history: getHistoryService(),
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        catchmentBufferMeters: parsed.data.catchmentBufferMeters,
        demResolutionMeters: parsed.data.demResolutionMeters,
        forceRefresh: parsed.data.forceRefresh,
        log,
      });
    } catch (err) {
      // Unexpected throw out of the worker — the worker is supposed to
      // catch every recoverable failure mode and return a typed
      // upstream-error result. Reaching here is a bug; surface it as
      // a clean 500 so the FE doesn't have to branch on HTML.
      log.error(
        { err, engagementId },
        "site-topography refresh: unhandled worker error",
      );
      res.status(500).json({
        error: "internal_worker_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const { status, body } = ingestResultToHttp(result);
    res.status(status).json(body);
  },
);

router.get(
  "/engagements/:id/site-topography",
  async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const engagementId = typeof rawId === "string" ? rawId : "";
    if (!engagementId) {
      res.status(400).json({ error: "missing_engagement_id" });
      return;
    }
    const log = reqLog(req);
    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }

    // 1) Fast path — active row already materialized.
    let row = await loadActiveSiteTopographyRow(engagementId);

    // 2) Replay path — no row, but maybe an event exists.
    if (!row) {
      const replayed = await rematerializeFromLatestEvent({
        history: getHistoryService(),
        engagementId,
        log,
      });
      if (replayed.status === "no-event") {
        res.status(404).json({
          status: "not-found",
          reason: replayed.reason,
        });
        return;
      }
      if (replayed.status === "error") {
        res.status(500).json({
          status: "error",
          reason: replayed.reason,
        });
        return;
      }
      // Re-read the row now that the materializer has written it.
      row = await loadActiveSiteTopographyRow(engagementId);
      if (!row) {
        res.status(500).json({
          status: "error",
          reason:
            "Replay-from-events succeeded but the materializable_elements row is still missing — investigate.",
        });
        return;
      }
    }

    res.status(200).json({
      status: "ok",
      materializableElementId: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // The full read model. SiteMap (Phase 2D.x PR4) reads
      // `contoursGeoJson` directly off this; other consumers can
      // peek at `demRef` / provenance metadata.
      propertySet: row.propertySet,
    });
  },
);

export default router;
