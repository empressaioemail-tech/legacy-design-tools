/**
 * Place graph HTTP API — resolve, layers, dossier (snapshot-first).
 *
 *   POST /api/brokerage/v1/place/resolve
 *   GET  /api/brokerage/v1/place/:placeKey/layers
 *   GET  /api/brokerage/v1/place/:placeKey/dossier
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, placeLayerSnapshots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { isBrokerageServiceCaller } from "../middlewares/brokerageServiceAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import {
  parseCoordPlaceKey,
  resolvePlace,
  type PlaceResolveInput,
} from "../lib/placeResolve";
import { fetchBrokerageSiteContext } from "../lib/brokerageSiteContext";
import { buildPlaceDossier } from "../lib/placeDossier";
import { listingKeyFromAddress } from "../lib/brokerageWorkspace";
import { keyFromEngagement } from "@workspace/codes";
import {
  buildPlaceLayerDid,
  buildPropertyWorkspaceDid,
} from "../lib/brokerageBriefAtoms";
import {
  buildPlaceParcelAtoms,
  jurisdictionKeyFromPlaceContext,
} from "../lib/placeParcelAtoms";
import {
  runWarmingCascade,
  verifySnapshotCoverage,
  K1_OUTCOME_LANDING_SCHEMA,
} from "../lib/warmingHarness";

const WARMING_BODY = z.object({
  address: z.string().min(1),
  synthetic: z.literal(true).default(true),
});

const RESOLVE_BODY = z
  .object({
    address: z.string().min(1).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
  })
  .refine((b) => b.address || (b.lat != null && b.lng != null), {
    message: "address or lat/lng required",
  });

export const brokeragePlaceRouter: IRouter = Router();

brokeragePlaceRouter.use(brokerageCors);
// Service callers (SERVICE_API_KEY Bearer) are authenticated by the outer
// requireBrokerageAuthOrServiceToken on brokerageV1; the inner brokerageAuth
// only knows install/user auth and would 401 them (the #232/#234/#236 class).
brokeragePlaceRouter.use((req: Request, res: Response, next) => {
  if (isBrokerageServiceCaller(req)) {
    next();
    return;
  }
  brokerageAuth(req, res, next);
});

brokeragePlaceRouter.post("/resolve", async (req: Request, res: Response) => {
  const parse = RESOLVE_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json(
      gtmErrorBody(
        "validation_error",
        "invalid_request",
        "Invalid place resolve body",
      ),
    );
    return;
  }

  const body = parse.data;
  const input: PlaceResolveInput =
    body.lat != null && body.lng != null
      ? { lat: body.lat, lng: body.lng, address: body.address }
      : { address: body.address! };

  const result = await resolvePlace(input);
  if ("errorClass" in result) {
    const status = result.errorClass === "geocode_miss" ? 422 : 400;
    res.status(status).json(result);
    return;
  }

  res.json(result);
});

async function coordsForPlaceKey(
  placeKey: string,
): Promise<{
  lat: number;
  lng: number;
  address?: string;
  city?: string | null;
  state?: string | null;
} | null> {
  const parsed = parseCoordPlaceKey(placeKey);
  if (parsed) return { ...parsed };

  if (placeKey.startsWith("ll:")) {
    const [row] = await db
      .select({
        lat: placeLayerSnapshots.latRounded,
        lng: placeLayerSnapshots.lngRounded,
      })
      .from(placeLayerSnapshots)
      .where(eq(placeLayerSnapshots.placeKey, placeKey))
      .limit(1);
    if (row) {
      return {
        lat: Number(row.lat),
        lng: Number(row.lng),
      };
    }
  }
  return null;
}

brokeragePlaceRouter.get(
  "/:placeKey/layers",
  async (req: Request, res: Response) => {
    const placeKey = decodeURIComponent(
      (Array.isArray(req.params.placeKey)
        ? req.params.placeKey[0]
        : req.params.placeKey) ?? "",
    ).trim();
    if (!placeKey) {
      res.status(400).json(
        gtmErrorBody("validation_error", "invalid_request", "placeKey required"),
      );
      return;
    }

    const coords = await coordsForPlaceKey(placeKey);
    if (!coords) {
      res.status(404).json(
        gtmErrorBody(
          "geocode_miss",
          "not_found",
          "Unknown placeKey — resolve an address first",
        ),
      );
      return;
    }

    const siteContext = await fetchBrokerageSiteContext({
      latitude: coords.lat,
      longitude: coords.lng,
      address: coords.address,
      jurisdictionCity: coords.city ?? null,
      jurisdictionState: coords.state ?? null,
    });

    res.json({
      placeKey: siteContext.placeKey,
      layers: siteContext.layers.map((layer) => ({
        layerKind: layer.layerKind,
        adapterKey: layer.adapterKey,
        tier: layer.tier,
        status: layer.status,
        provenance: layer.fromArchive ? "snapshot" : "live",
        did: buildPlaceLayerDid(layer.layerKind, siteContext.placeKey),
        provider: layer.provider ?? null,
        summary: layer.summary ?? null,
        asOf: layer.snapshotDate ?? new Date().toISOString(),
        readContract: layer.readContract ?? null,
        citation: {
          source: layer.fromArchive
            ? "place_layer_snapshot"
            : (layer.provider ?? layer.adapterKey),
          adapterKey: layer.adapterKey,
          asOf: layer.snapshotDate ?? new Date().toISOString(),
        },
      })),
    });
  },
);

brokeragePlaceRouter.get(
  "/:placeKey/dossier",
  async (req: Request, res: Response) => {
    const placeKey = decodeURIComponent(
      (Array.isArray(req.params.placeKey)
        ? req.params.placeKey[0]
        : req.params.placeKey) ?? "",
    ).trim();
    if (!placeKey) {
      res.status(400).json(
        gtmErrorBody("validation_error", "invalid_request", "placeKey required"),
      );
      return;
    }

    const coords = await coordsForPlaceKey(placeKey);
    if (!coords) {
      res.status(404).json(
        gtmErrorBody(
          "geocode_miss",
          "not_found",
          "Unknown placeKey — resolve an address first",
        ),
      );
      return;
    }

    const jurisdiction_key = keyFromEngagement({
      jurisdictionCity: coords.city ?? null,
      jurisdictionState: coords.state ?? null,
      address: coords.address ?? placeKey,
    });

    const siteContext = await fetchBrokerageSiteContext({
      latitude: coords.lat,
      longitude: coords.lng,
      address: coords.address,
      jurisdictionCity: coords.city ?? null,
      jurisdictionState: coords.state ?? null,
    });

    const listingKey = coords.address
      ? listingKeyFromAddress(coords.address)
      : placeKey;

    const dossier = await buildPlaceDossier({
      placeKey: siteContext.placeKey,
      jurisdiction_key,
      siteContext,
      listingKey,
    });

    res.json({
      ...dossier,
      workspaceDid: buildPropertyWorkspaceDid(listingKey),
    });
  },
);

/** Decision 6 — uncapped parcel→atoms trace for spine console E7. */
brokeragePlaceRouter.get(
  "/:placeKey/atoms",
  async (req: Request, res: Response) => {
    const placeKey = decodeURIComponent(
      (Array.isArray(req.params.placeKey)
        ? req.params.placeKey[0]
        : req.params.placeKey) ?? "",
    ).trim();
    if (!placeKey) {
      res.status(400).json(
        gtmErrorBody("validation_error", "invalid_request", "placeKey required"),
      );
      return;
    }

    const coords = await coordsForPlaceKey(placeKey);
    if (!coords) {
      res.status(404).json(
        gtmErrorBody(
          "geocode_miss",
          "not_found",
          "Unknown placeKey — resolve an address first",
        ),
      );
      return;
    }

    const jurisdictionKey = jurisdictionKeyFromPlaceContext({
      city: coords.city,
      state: coords.state,
      address: coords.address ?? placeKey,
    });

    const body = await buildPlaceParcelAtoms({
      placeKey,
      jurisdictionKey,
      address: coords.address,
    });
    res.json(body);
  },
);

/** W1 warming cascade scaffold — W4 snapshot gate + W5 synthetic tag. */
brokeragePlaceRouter.post("/warming/run", async (req: Request, res: Response) => {
  const parse = WARMING_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json(
      gtmErrorBody(
        "validation_error",
        "invalid_request",
        "address + synthetic:true required",
      ),
    );
    return;
  }

  const result = await runWarmingCascade({
    address: parse.data.address,
    synthetic: true,
  });
  res.json({
    ...result,
    k1LandingSchema: K1_OUTCOME_LANDING_SCHEMA,
  });
});

/** Snapshot coverage probe (gates warming). */
brokeragePlaceRouter.get(
  "/:placeKey/snapshot-coverage",
  async (req: Request, res: Response) => {
    const placeKey = decodeURIComponent(
      (Array.isArray(req.params.placeKey)
        ? req.params.placeKey[0]
        : req.params.placeKey) ?? "",
    ).trim();
    if (!placeKey) {
      res.status(400).json(
        gtmErrorBody("validation_error", "invalid_request", "placeKey required"),
      );
      return;
    }
    res.json(await verifySnapshotCoverage(placeKey));
  },
);
