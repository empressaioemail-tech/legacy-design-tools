/**
 * P-430 — City limits + ETJ viewport boundaries for Property Explorer map layer.
 *
 *   GET /api/brokerage/v1/place/jurisdiction-boundaries/near-bbox
 *     ?westLng=&southLat=&eastLng=&northLat=
 *
 * Public-record geometry from `tx_city_boundary` and served `tx_etj_boundary`
 * rings (same sources as the inspect-card determination). Service token required
 * (PE spine proxy).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import { assembleJurisdictionBoundariesNearBbox } from "../lib/jurisdictionBoundariesNearBbox";

export const brokeragePlaceJurisdictionBoundariesRouter: IRouter = Router();

const QUERY = z.object({
  westLng: z.coerce.number(),
  southLat: z.coerce.number(),
  eastLng: z.coerce.number(),
  northLat: z.coerce.number(),
});

brokeragePlaceJurisdictionBoundariesRouter.get(
  "/jurisdiction-boundaries/near-bbox",
  async (req: Request, res: Response) => {
    const parsed = QUERY.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          "westLng,southLat,eastLng,northLat are required",
        ),
      );
      return;
    }

    const result = await assembleJurisdictionBoundariesNearBbox(parsed.data);
    if ("error" in result) {
      res.status(result.status).json(
        gtmErrorBody("validation_error", "invalid_request", result.error),
      );
      return;
    }
    res.json(result);
  },
);
