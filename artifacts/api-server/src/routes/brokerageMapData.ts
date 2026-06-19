/**
 * Max-tier map-data consume — gate-fronted map-layers assemble + GIS GeoJSON proxy.
 *
 *   POST /api/brokerage/v1/map-data
 *   POST /api/brokerage/v1/map-data/gis-layer
 *   GET  /api/brokerage/v1/map-data/gis-layers
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, brokerageUserProfiles } from "@workspace/db";
import { resolveJurisdiction } from "@workspace/adapters";
import { AdapterRunError } from "@workspace/adapters/types";
import { logger } from "../lib/logger";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import { resolveRequestJurisdictionTenant } from "../lib/gateFrontSeam";
import { resolveInvestorPackageTier } from "../lib/brokerageTierGate";
import { packageTierFromProfile } from "../lib/brokerageUserProfile";
import {
  routeAssembleMapLayers,
  defaultCatchmentBbox,
  type MapLayersAssembleRequest,
} from "../lib/engineSpineMapLayers";
import {
  formatEngineSpineFailure,
  isEngineSpineConfigured,
} from "../lib/engineSpineClient";
import { buildMapReasoningOverlays } from "../lib/brokerageMapReasoningOverlays";
import { buildInvestorVerdict } from "../lib/brokerageInvestorVerdict";
import type { BrokerageSiteContextLayer } from "../lib/brokerageSiteContext";
import {
  entitlementPackageTier,
  resolveEntitlementSnapshot,
} from "../lib/brokerageEntitlement";
import {
  listGisLayerEndpoints,
  queryGisLayerGeoJson,
  type GisProxyLayerKey,
} from "../lib/brokerageGisLayers";
import {
  gisFixtureRequested,
  loadGisLayerFixture,
} from "../lib/brokerageGisLayerFixtures";

function mapDataMaxInstallOverride(
  installId: string | null,
): "max" | null {
  const raw = process.env.BROKERAGE_MAP_DATA_MAX_INSTALL_IDS?.trim();
  if (!raw || !installId) return null;
  const allowed = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return allowed.has(installId) ? "max" : null;
}

async function resolveMapDataPackageTier(
  req: Request,
  installId: string | null,
): Promise<{
  packageTier: ReturnType<typeof resolveInvestorPackageTier>;
  profileRow: typeof brokerageUserProfiles.$inferSelect | null;
}> {
  const subjectId = req.session?.requestor?.id ?? null;
  let profileRow: typeof brokerageUserProfiles.$inferSelect | null = null;
  if (subjectId) {
    const rows = await db
      .select()
      .from(brokerageUserProfiles)
      .where(eq(brokerageUserProfiles.ownerUserId, subjectId))
      .limit(1);
    profileRow = rows[0] ?? null;
  }

  const entitlementSnapshot = await resolveEntitlementSnapshot(req);
  const entitlementTier = entitlementSnapshot
    ? entitlementPackageTier(entitlementSnapshot)
    : null;

  const packageTier = resolveInvestorPackageTier({
    brokerageAuthTier: req.brokerageAuth?.tier ?? null,
    profileTier: packageTierFromProfile(profileRow),
    entitlementTier,
    tier: mapDataMaxInstallOverride(installId),
  });

  return { packageTier, profileRow };
}

export const brokerageMapDataRouter: IRouter = Router();

const MAP_DATA_BODY = z
  .object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    address: z.string().nullable().optional(),
    parcelKey: z.string().min(1).optional(),
    jurisdictionCity: z.string().nullable().optional(),
    jurisdictionState: z.string().nullable().optional(),
    layers: z
      .array(
        z.enum([
          "parcel-polygon",
          "flood-zone",
          "floodway",
          "dem",
          "topography",
          "opportunity-zone-tract",
          "zoning",
        ]),
      )
      .optional(),
    forceRefresh: z.boolean().optional(),
    /** Optional brief layers for reasoning overlay projection. */
    contextLayers: z.array(z.record(z.unknown())).optional(),
  })
  .strict();

const GIS_BBOX_BODY = z
  .object({
    westLng: z.number().finite(),
    southLat: z.number().finite(),
    eastLng: z.number().finite(),
    northLat: z.number().finite(),
  })
  .strict();

const GIS_BBOX_CARDINAL_BODY = z
  .object({
    west: z.number().finite(),
    south: z.number().finite(),
    east: z.number().finite(),
    north: z.number().finite(),
  })
  .strict();

const GIS_BBOX_ESRI_BODY = z
  .object({
    xmin: z.number().finite(),
    ymin: z.number().finite(),
    xmax: z.number().finite(),
    ymax: z.number().finite(),
  })
  .strict();

const GIS_LAYER_BODY = z
  .object({
    layer: z.enum(["fema", "parcels"]),
    latitude: z.number().finite().optional(),
    longitude: z.number().finite().optional(),
    fixture: z.boolean().optional(),
    forceRefresh: z.boolean().optional(),
    bbox: z
      .union([GIS_BBOX_BODY, GIS_BBOX_CARDINAL_BODY, GIS_BBOX_ESRI_BODY])
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.bbox) return;
    if (body.latitude == null || body.longitude == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide bbox for viewport query or latitude+longitude for pin-intersect",
        path: ["bbox"],
      });
    }
  });

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

function sendTierRequired(
  res: Response,
  packageTier: ReturnType<typeof resolveInvestorPackageTier>,
) {
  res.status(403).json({
    error: "tier_required",
    message: "Max tier subscription required for site map data.",
    packageTier,
  });
}

brokerageMapDataRouter.get("/gis-layers", async (req: Request, res: Response) => {
  const installId = installIdFromRequest(req);
  const { packageTier } = await resolveMapDataPackageTier(req, installId);
  if (packageTier !== "max") {
    sendTierRequired(res, packageTier);
    return;
  }

  res.json({
    layers: listGisLayerEndpoints().map((layer) => ({
      layer: layer.layer,
      serviceUrl: layer.serviceUrl,
      provider: layer.provider,
      adapterKey: layer.adapterKey,
    })),
    packageTier,
  });
});

brokerageMapDataRouter.post("/gis-layer", async (req: Request, res: Response) => {
  const parsed = GIS_LAYER_BODY.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }

  const log = reqLog(req);
  const installId = installIdFromRequest(req);
  const { packageTier } = await resolveMapDataPackageTier(req, installId);
  if (packageTier !== "max") {
    sendTierRequired(res, packageTier);
    return;
  }

  try {
    if (gisFixtureRequested(req, parsed.data)) {
      const fixture = loadGisLayerFixture(parsed.data.layer as GisProxyLayerKey);
      if (!fixture) {
        res.status(503).json({
          error: "fixture_unavailable",
          message:
            "GIS fixture file missing. Run artifacts/api-server/src/captureBrokerageGisFixtureCli.ts when Cotality Spatial Tile quota allows.",
          layer: parsed.data.layer,
        });
        return;
      }
      res.json({
        ...fixture.result,
        packageTier,
        fixture: true,
        fixtureMeta: fixture.manifest,
      });
      return;
    }

    const refreshQuery = req.query.refresh;
    const forceRefresh =
      parsed.data.forceRefresh === true ||
      refreshQuery === "1" ||
      refreshQuery === "true";

    const result = await queryGisLayerGeoJson({
      layer: parsed.data.layer as GisProxyLayerKey,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      bbox: parsed.data.bbox,
      forceRefresh,
    });
    res.json({
      layer: result.layer,
      provider: result.provider,
      adapterKey: result.adapterKey,
      serviceUrl: result.serviceUrl,
      featureCount: result.featureCount,
      queryMode: result.queryMode,
      truncated: result.truncated ?? false,
      geojson: result.geojson,
      packageTier,
    });
  } catch (err) {
    if (err instanceof AdapterRunError) {
      const status = err.code === "no-coverage" ? 404 : 502;
      res.status(status).json({
        error: err.code,
        message: err.message,
        layer: parsed.data.layer,
      });
      return;
    }
    log.warn({ err }, "brokerage map-data: gis-layer proxy failed");
    res.status(502).json({
      error: "gis_layer_proxy_failed",
      message: String((err as Error).message || err),
    });
  }
});

brokerageMapDataRouter.post("/", async (req: Request, res: Response) => {
  const parsed = MAP_DATA_BODY.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }

  const log = reqLog(req);
  const installId = installIdFromRequest(req);
  const { packageTier } = await resolveMapDataPackageTier(req, installId);

  if (packageTier !== "max") {
    sendTierRequired(res, packageTier);
    return;
  }

  if (!isEngineSpineConfigured()) {
    res.status(503).json({
      error: "map_layers_unavailable",
      message: "ENGINE_API_URL is not configured for map-layers assemble.",
    });
    return;
  }

  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: parsed.data.jurisdictionCity ?? null,
    jurisdictionState: parsed.data.jurisdictionState ?? null,
    address: parsed.data.address ?? null,
  });

  const assembleBody: MapLayersAssembleRequest = {
    parcel: {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      address: parsed.data.address ?? null,
      parcelKey: parsed.data.parcelKey,
    },
    jurisdiction,
    layers: parsed.data.layers,
    forceRefresh: parsed.data.forceRefresh,
    bbox: defaultCatchmentBbox(parsed.data.latitude, parsed.data.longitude),
  };

  try {
    const { payload, honesty } = await routeAssembleMapLayers(
      assembleBody,
      {
        jurisdictionTenant: resolveRequestJurisdictionTenant(req),
        subjectId: req.session?.requestor?.id ?? undefined,
        accessTier: "public-paid",
      },
      req,
    );

    const contextLayers = (parsed.data.contextLayers ?? []) as unknown as BrokerageSiteContextLayer[];
    const verdict =
      contextLayers.length > 0
        ? buildInvestorVerdict({
            layers: contextLayers,
            corpusStatus: "unknown",
            finishedAt: new Date().toISOString(),
          })
        : null;

    const reasoningOverlays = buildMapReasoningOverlays({
      assemble: payload,
      verdict,
      mudPidLine: verdict?.mudPidLine ?? null,
    });

    res.json({
      mapData: payload,
      reasoningOverlays,
      honesty,
      packageTier,
    });
  } catch (err) {
    const failure = formatEngineSpineFailure(err);
    log.warn({ err, failure }, "brokerage map-data: spine assemble failed");
    res.status(502).json({
      error: "map_layers_assemble_failed",
      ...failure,
    });
  }
});
