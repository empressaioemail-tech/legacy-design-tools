/**
 * P-75 who-serves HTTP attach.
 *
 * GET /api/who-serves?lat=&lng=
 * Always returns { holders, residual, asOf }. A miss is holders [] plus
 * the residual sentence, never HTTP 200 {}.
 *
 * The loader is injected so unit tests never import @workspace/db.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  serveWhoServesAtPoint,
  type WhoServesCandidate,
} from "../lib/whoServesRead";

export type WhoServesLoader = (
  longitude: number,
  latitude: number,
) => Promise<WhoServesCandidate[]>;

export function createWhoServesRouter(
  load: WhoServesLoader,
  stagingRowCount?: () => Promise<number>,
): IRouter {
  const router: IRouter = Router();

  router.get("/", async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({
        error: "who_serves_point_required",
        message: "GET /api/who-serves requires finite lat and lng query params.",
      });
      return;
    }
    try {
      const section = await serveWhoServesAtPoint(
        lng,
        lat,
        load,
        stagingRowCount,
      );
      res.json(section);
    } catch (err) {
      const message = err instanceof Error ? err.message : "who-serves read failed";
      res.status(503).json({
        error: "who_serves_read_failed",
        message,
      });
    }
  });

  return router;
}
