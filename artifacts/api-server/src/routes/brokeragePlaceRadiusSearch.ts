/**
 *   GET /api/brokerage/v1/place/radius-search?lat=&lng=&radiusFt=&cap=
 *
 * Parcel set given a point and a radius in feet. Truncation is a field.
 * Mounted under the brokerage service gate.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import {
  RADIUS_SEARCH_CAP,
  RADIUS_SEARCH_MAX_FT,
  searchParcelsByRadius,
} from "../lib/txgioRadiusSearch";

export const brokeragePlaceRadiusSearchRouter: IRouter = Router();

const QUERY = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radiusFt: z.coerce.number(),
  cap: z.coerce.number().int().min(1).max(RADIUS_SEARCH_CAP).optional(),
});

brokeragePlaceRadiusSearchRouter.get(
  "/radius-search",
  async (req: Request, res: Response) => {
    const parsed = QUERY.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          `lat, lng, and radiusFt are required; cap is optional (1-${RADIUS_SEARCH_CAP}); radiusFt max ${RADIUS_SEARCH_MAX_FT}`,
        ),
      );
      return;
    }

    const result = await searchParcelsByRadius(parsed.data);
    if ("refused" in result) {
      res.status(422).json(
        gtmErrorBody("serve_refused", result.code, result.reason),
      );
      return;
    }
    res.json(result);
  },
);
