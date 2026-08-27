/**
 * Situs prefix search for Property Explorer typeahead.
 *
 *   GET /api/brokerage/v1/place/situs-search?q=<text>&limit=<n>
 *
 * Returns authoritative parcel situs hits from the self-hosted TxGIO store
 * across every `txgio-store` county. Mounted under the brokerage service gate.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import { searchPlaceByPrefix } from "../lib/txgioAddressResolve";

const PARCEL_NODE_ID_RE = /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const brokeragePlaceSitusSearchRouter: IRouter = Router();

const QUERY = z.object({
  q: z.string().trim().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

brokeragePlaceSitusSearchRouter.get(
  "/situs-search",
  async (req: Request, res: Response) => {
    const parsed = QUERY.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          "q is required (max 256 chars); limit is optional (1-10)",
        ),
      );
      return;
    }

    const query = parsed.data.q;
    if (PARCEL_NODE_ID_RE.test(query)) {
      res.json({
        hits: [{ parcelNodeId: query, source: "parcel-node-id" }],
      });
      return;
    }

    const hits = await searchPlaceByPrefix({
      query,
      limit: parsed.data.limit,
    });
    res.json({ hits });
  },
);
