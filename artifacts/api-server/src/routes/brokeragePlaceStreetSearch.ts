/**
 *   GET /api/brokerage/v1/place/street-search?q=<bare street, locality>&cap=&countyFips=
 *
 * Everyone on Pine St. Locality or countyFips required. Truncation is a field.
 * Mounted under the brokerage service gate.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import {
  STREET_SEARCH_CAP,
  searchParcelsByBareStreet,
} from "../lib/txgioStreetSearch";

export const brokeragePlaceStreetSearchRouter: IRouter = Router();

const QUERY = z.object({
  q: z.string().trim().min(1).max(256),
  cap: z.coerce.number().int().min(1).max(STREET_SEARCH_CAP).optional(),
  countyFips: z.string().trim().regex(/^\d{5}$/).optional(),
});

brokeragePlaceStreetSearchRouter.get(
  "/street-search",
  async (req: Request, res: Response) => {
    const parsed = QUERY.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          `q is required (max 256 chars); cap is optional (1-${STREET_SEARCH_CAP}); countyFips is an optional 5-digit FIPS`,
        ),
      );
      return;
    }

    const result = await searchParcelsByBareStreet({
      query: parsed.data.q,
      cap: parsed.data.cap,
      countyFips: parsed.data.countyFips,
    });
    if ("refused" in result) {
      res.status(422).json(
        gtmErrorBody("serve_refused", result.code, result.reason),
      );
      return;
    }
    res.json(result);
  },
);
