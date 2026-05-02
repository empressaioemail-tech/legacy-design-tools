/**
 * /api/briefing-sources/:id/glb — DA-MV-1 viewer bytes endpoint.
 *
 * Streams the converted glb (`model/gltf-binary`) for one briefing
 * source whose DXF→glb conversion has reached `ready`. The viewer
 * (`SiteContextViewer`) calls this endpoint per source it needs to
 * render — keeping the bytes off the briefing-list payload (which
 * stays JSON) means a freshly-uploaded source doesn't bloat the
 * Site Context tab's first paint.
 *
 * Auth posture: gated by `requireArchitectAudience` (V1-3). Earlier
 * revisions left this route open on the rationale that "the bytes
 * are content-addressed by the row id alone" — V1-3 retired that
 * posture along with the matching gate on
 * `/materializable-elements/:id/glb` so the two GLB surfaces fail
 * closed in production until real auth lands. Why still a top-level
 * `/briefing-sources/:id/glb` rather than nesting under engagements:
 * the gate is audience-shaped (no engagement-membership table
 * exists in this codebase), and the viewer holds the row id
 * directly from the briefing read. Mirrors the
 * `/api/sheets/:id/full.png` precedent (`routes/sheets.ts:846-851`)
 * for "fetch bytes by id" without an engagement prefix.
 *
 * Caching contract:
 *   - ETag is `"<sha1(bytes)>"`. Re-running conversion against the
 *     same row writes a new glb, so the bytes hash changes and the
 *     ETag busts; a no-op retry that returns the same bytes preserves
 *     the ETag and the client's 304 cache hit holds.
 *   - `Cache-Control: public, max-age=86400, immutable`. Since the
 *     URL is keyed by row id and a fresh upload writes a new row,
 *     the `immutable` hint is safe within a row's lifetime — the only
 *     mutation path (the retry endpoint) is rare and the ETag bust
 *     covers it.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { db, briefingSources } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetBriefingSourceGlbParams } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";
import { requireArchitectAudience } from "../lib/audienceGuards";

const BRIEFING_SOURCE_AUDIENCE_ERROR =
  "briefing_source_requires_architect_audience";

const router: IRouter = Router();

/**
 * Lazy singleton for the same reason the parcelBriefings route holds
 * one — the constructor reads env on first call, and tests inject env
 * via the harness rather than at module load.
 */
let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

router.get(
  "/briefing-sources/:id/glb",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BRIEFING_SOURCE_AUDIENCE_ERROR)) {
      return;
    }
    const paramsParse = GetBriefingSourceGlbParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_briefing_source_id" });
      return;
    }
    const { id } = paramsParse.data;

    try {
      const rows = await db
        .select({
          id: briefingSources.id,
          glbObjectPath: briefingSources.glbObjectPath,
          conversionStatus: briefingSources.conversionStatus,
        })
        .from(briefingSources)
        .where(eq(briefingSources.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "briefing_source_not_found" });
        return;
      }
      // The viewer should only ever request bytes for sources the
      // briefing payload reported as `ready`. Anything else — null
      // (QGIS branch), `pending`, `converting`, `failed`, `dxf-only`
      // — gets a uniform 404 so the viewer can render a single
      // "not available" branch without per-status special-casing.
      if (row.conversionStatus !== "ready" || !row.glbObjectPath) {
        res.status(404).json({ error: "glb_not_ready" });
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await objectStorage().getObjectEntityBytes(row.glbObjectPath);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          // The row says `ready` but the bytes are gone. This is a
          // bucket-vs-row drift the architect can't reconcile from
          // the UI; surface as 404 so the viewer renders a "not
          // available" pill, and log loudly so an operator sees it.
          logger.error(
            { id, glbObjectPath: row.glbObjectPath },
            "glb bytes missing for briefing source marked ready",
          );
          res.status(404).json({ error: "glb_bytes_missing" });
          return;
        }
        throw err;
      }

      const etag = `"${createHash("sha1").update(bytes).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("ETag", etag);
      res.end(bytes);
    } catch (err) {
      logger.error({ err, id }, "serve briefing source glb failed");
      res.status(500).json({ error: "Failed to load briefing source glb" });
    }
  },
);

export default router;
