/**
 * Read-only diagnostic for the live easement reader (easements plan Phase 0, 2026-11-05).
 *
 *   POST /property-explorer/v1/internal/live-easement-gis/check
 *   Authorization: Bearer <SERVICE_API_KEY>
 *   { "countyFips": "48021", "parcelKey": "48021:38368", "geometry": { "type": "Polygon", ... } }
 *
 * Runs `queryLiveEasementGisForParcel` exactly as a records-request job does, and answers with each
 * layer's status, feature count and feature ids, plus each hit's recording references. It writes
 * nothing: no records request, no job, no row. It exists so integration can confirm production
 * returns features (not a zero) without creating a records request. The parcel polygon is supplied by
 * the caller (for example from the county's public parcel layer); the layers queried are the fixed
 * list in liveEasementGisQuery.ts, so no caller-chosen URL is ever fetched.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { queryLiveEasementGisForParcel } from "../lib/liveEasementGisQuery";
import { logger } from "../lib/logger";
import { requireServiceToken } from "../middlewares/serviceAuth";

/** Beyond this many vertices the request is refused: a parcel, not a county. */
export const LIVE_EASEMENT_CHECK_MAX_VERTICES = 20_000;

const Position = z.tuple([z.number().finite(), z.number().finite()]).rest(z.number().finite());
const Ring = z.array(Position).min(4);
const BodySchema = z.object({
  countyFips: z.string().regex(/^\d{5}$/),
  parcelKey: z.string().min(1).max(200),
  geometry: z.discriminatedUnion("type", [
    z.object({ type: z.literal("Polygon"), coordinates: z.array(Ring).min(1) }),
    z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(Ring).min(1)).min(1) }),
  ]),
});

function vertexCount(geometry: z.infer<typeof BodySchema>["geometry"]): number {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polys.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

const router: IRouter = Router();

router.post(
  "/property-explorer/v1/internal/live-easement-gis/check",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    const { countyFips, parcelKey, geometry } = parsed.data;
    if (vertexCount(geometry) > LIVE_EASEMENT_CHECK_MAX_VERTICES) {
      res.status(413).json({ error: "geometry_too_large", maxVertices: LIVE_EASEMENT_CHECK_MAX_VERTICES });
      return;
    }
    try {
      const audit = await queryLiveEasementGisForParcel({ parcelKey, countyFips, parcelGeometryGeojson: geometry });
      res.json({
        queriedAt: audit.queriedAt,
        parcelKey: audit.parcelKey,
        countyFips: audit.countyFips,
        layers: audit.layers.map((l) => ({
          sourceLayerId: l.sourceLayerId,
          featureCount: l.featureCount,
          featureIds: l.featureIds,
          ...(l.pages !== undefined ? { pages: l.pages } : {}),
          ...(l.skippedReason ? { skippedReason: l.skippedReason } : {}),
        })),
        hits: audit.hits.map((h) => ({ sourceLayerId: h.sourceLayerId, featureIds: h.featureIds, recordingRefs: h.recordingRefs })),
      });
    } catch (err) {
      logger.error({ err, parcelKey, countyFips }, "live easement check failed");
      res.status(502).json({ error: "live_gis_query_failed" });
    }
  },
);

export default router;
