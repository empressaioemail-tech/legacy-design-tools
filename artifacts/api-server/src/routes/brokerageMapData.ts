/**
 * Max-tier map-data consume — gate-fronted map-layers assemble + reasoning overlays.
 *
 *   POST /api/brokerage/v1/map-data
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, brokerageUserProfiles } from "@workspace/db";
import { resolveJurisdiction } from "@workspace/adapters";
import { logger } from "../lib/logger";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import { resolveRequestJurisdictionTenant } from "../lib/gateFrontSeam";
import {
  resolveInvestorPackageTier,
} from "../lib/brokerageTierGate";
import {
  packageTierFromProfile,
} from "../lib/brokerageUserProfile";
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

function reqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

brokerageMapDataRouter.post("/", async (req: Request, res: Response) => {
  const parsed = MAP_DATA_BODY.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }

  const log = reqLog(req);
  const subjectId = req.session?.requestor?.id ?? null;
  const installId = installIdFromRequest(req);
  let profileRow: typeof brokerageUserProfiles.$inferSelect | null = null;
  if (subjectId) {
    const rows = await db
      .select()
      .from(brokerageUserProfiles)
      .where(eq(brokerageUserProfiles.ownerUserId, subjectId))
      .limit(1);
    profileRow = rows[0] ?? null;
  }
  const packageTier = resolveInvestorPackageTier({
    brokerageAuthTier: req.brokerageAuth?.tier ?? null,
    profileTier: packageTierFromProfile(profileRow),
    entitlementTier: mapDataMaxInstallOverride(installId),
  });

  if (packageTier !== "max") {
    res.status(403).json({
      error: "tier_required",
      message: "Max tier required for site map layer assembly.",
      packageTier,
    });
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
        subjectId: subjectId ?? undefined,
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
