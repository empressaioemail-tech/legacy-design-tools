/**
 * Site-drainage hydrology worker — Phase 2D.2/2D.3.
 *
 * Requires an existing `site-topography` ingest (DEM in GCS). Runs D8
 * flow analysis + optional rainfall simulation, emits
 * `site-drainage.computed` / `.refreshed` events.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, engagements as engagementsTable } from "@workspace/db";
import type { EventAnchoringService } from "@hauska/atom-contract";
import {
  runHydrologyWorker,
  resolveRainfallForcing,
  rainfallForcingDepthMm,
  type BboxWgs84,
  type RainfallForcingSource,
} from "@workspace/site-context/server";
import { SITE_DRAINAGE_INGEST_ACTOR_ID } from "@workspace/server-actor-ids";
import { ObjectStorageService } from "./objectStorage";
import { logger as defaultLogger } from "./logger";
import {
  parseDemBytes,
  type SiteTopographyEventPayload,
} from "./siteTopographyIngest";
import {
  loadActiveSiteTopographyRow,
  rematerializeFromLatestEvent,
} from "./siteTopographyMaterializer";
import {
  materializeSiteDrainageFromEvent,
  rematerializeSiteDrainageFromLatestEvent,
  loadActiveSiteDrainageRow,
} from "./siteDrainageMaterializer";
import {
  SITE_DRAINAGE_EVENT_TYPES,
  type SiteDrainageEventType,
} from "../atoms/site-drainage.atom";
import {
  DEFAULT_ACCUMULATION_THRESHOLD,
  resolveAccumulationThreshold,
} from "./siteDrainageThreshold";

export {
  DEFAULT_ACCUMULATION_THRESHOLD,
  MIN_ACCUMULATION_THRESHOLD,
  resolveAccumulationThreshold,
} from "./siteDrainageThreshold";
const WORKER_VERSION = "site-drainage-ingest@1.0.0";

export interface SiteDrainageEventPayload {
  schemaVersion: 1;
  computedOrigin: true;
  aiOrigin: false;
  computedAt: string;
  siteTopography: {
    atomEventId: string;
    demGcsObjectPath: string;
    inputSignature: string;
  };
  catchment: {
    bbox: BboxWgs84;
  };
  hydrology: {
    library: string;
    libraryVersion: string;
    routing: string;
    accumulationThreshold: number;
    flowLineCount: number;
    drainageZoneCount: number;
    pourPoint: { lng: number; lat: number };
  };
  rainfall: {
    depthInches: number;
    depthMm: number;
    forcingSource: string;
    forcingDetail: RainfallForcingSource;
    returnPeriodYears?: number;
  } | null;
  outputs: {
    drainageZonesGeoJson: unknown;
    flowLinesGeoJson: unknown;
    rainfallResultGeoJson: unknown | null;
  };
  inputSignature: string;
  workerVersion: string;
  previousAtomEventId?: string;
}

export type SiteDrainageIngestResult =
  | {
      status: "ok";
      atomEventId: string;
      eventType: SiteDrainageEventType;
      materializableElementId: string;
      flowLineCount: number;
      drainageZoneCount: number;
      rainfallDepthInches: number | null;
      forcingSource: string | null;
      reusedExisting: boolean;
    }
  | { status: "no-topography"; reason: string }
  | {
      status: "upstream-error";
      reason: string;
      code: string;
    };

export interface SiteDrainageIngestArgs {
  engagementId: string;
  history: EventAnchoringService;
  manualDepthInches?: number;
  returnPeriodYears?: number;
  accumulationThreshold?: number;
  forceRefresh?: boolean;
  /** When true, use Cotality hazards overlay for forcing (inert unless data passed). */
  useCotalityForcing?: boolean;
  log?: typeof defaultLogger;
  storage?: Pick<ObjectStorageService, "getObjectEntityBytes">;
}

function inputSignature(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function bboxCenter(bbox: BboxWgs84): { lng: number; lat: number } {
  return {
    lng: (bbox.westLng + bbox.eastLng) / 2,
    lat: (bbox.southLat + bbox.northLat) / 2,
  };
}

function forcingSourceLabel(forcing: RainfallForcingSource): string {
  if (forcing.kind === "manual") return "manual";
  if (forcing.kind === "noaa-atlas-14") return "noaa-atlas-14-pfds";
  return "cotality:hazards";
}

async function resolveTopographyPayload(
  engagementId: string,
  history: EventAnchoringService,
  log: typeof defaultLogger,
): Promise<
  | { status: "ok"; payload: SiteTopographyEventPayload; atomEventId: string }
  | { status: "no-topography"; reason: string }
> {
  let row = await loadActiveSiteTopographyRow(engagementId);
  if (!row) {
    const replayed = await rematerializeFromLatestEvent({
      history,
      engagementId,
      log,
    });
    if (replayed.status !== "ok") {
      return {
        status: "no-topography",
        reason:
          "No site-topography ingest — run POST /api/engagements/:id/site-topography/refresh first.",
      };
    }
    row = await loadActiveSiteTopographyRow(engagementId);
  }
  if (!row) {
    return { status: "no-topography", reason: "Site-topography row missing after replay." };
  }
  const atomEventId =
    typeof row.propertySet.atomEventId === "string"
      ? row.propertySet.atomEventId
      : "";
  const latest = await history.latestEvent({
    kind: "atom",
    entityType: "site-topography",
    entityId: engagementId,
  });
  if (!latest?.payload) {
    return { status: "no-topography", reason: "No site-topography event payload." };
  }
  return {
    status: "ok",
    payload: latest.payload as unknown as SiteTopographyEventPayload,
    atomEventId: atomEventId || latest.id,
  };
}

export async function ingestSiteDrainage(
  args: SiteDrainageIngestArgs,
): Promise<SiteDrainageIngestResult> {
  const log = args.log ?? defaultLogger;
  const storage = args.storage ?? new ObjectStorageService();

  const topo = await resolveTopographyPayload(
    args.engagementId,
    args.history,
    log,
  );
  if (topo.status !== "ok") {
    return topo;
  }
  const topoPayload = topo.payload;
  const catchmentBbox = topoPayload.catchment.bbox;

  const accThreshold = resolveAccumulationThreshold(
    topoPayload.dem.widthPx,
    topoPayload.dem.heightPx,
    args.accumulationThreshold,
  );

  const [engagement] = await db
    .select({
      latitude: engagementsTable.latitude,
      longitude: engagementsTable.longitude,
    })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, args.engagementId))
    .limit(1);

  const pour =
    engagement?.longitude != null && engagement?.latitude != null
      ? {
          lng: Number(engagement.longitude),
          lat: Number(engagement.latitude),
        }
      : bboxCenter(catchmentBbox);

  const rainfallForcing = await resolveRainfallForcing({
    lat: pour.lat,
    lng: pour.lng,
    manualDepthInches: args.manualDepthInches,
    returnPeriodYears: args.returnPeriodYears,
    useCotalityForcing: args.useCotalityForcing ?? false,
    cotalityForcing: null,
  });
  const rainfallDepthMm = rainfallForcingDepthMm(rainfallForcing);

  const signature = inputSignature({
    topoSignature: topoPayload.inputSignature,
    rainfallDepthMm,
    accThreshold,
    forcing: forcingSourceLabel(rainfallForcing),
  });

  const latestDrainage = await args.history.latestEvent({
    kind: "atom",
    entityType: "site-drainage",
    entityId: args.engagementId,
  });
  const latestSig =
    latestDrainage?.payload &&
    typeof latestDrainage.payload === "object" &&
    !Array.isArray(latestDrainage.payload) &&
    typeof (latestDrainage.payload as { inputSignature?: unknown }).inputSignature ===
      "string"
      ? ((latestDrainage.payload as { inputSignature: string }).inputSignature)
      : null;

  if (latestDrainage && latestSig === signature && !args.forceRefresh) {
    const materialized = await rematerializeSiteDrainageFromLatestEvent({
      history: args.history,
      engagementId: args.engagementId,
      log,
    });
    if (materialized.status !== "ok") {
      return {
        status: "upstream-error",
        reason: materialized.reason,
        code: "materializer-failed",
      };
    }
    const ps = (await loadActiveSiteDrainageRow(args.engagementId))?.propertySet;
    return {
      status: "ok",
      atomEventId: latestDrainage.id,
      eventType: latestDrainage.eventType as SiteDrainageEventType,
      materializableElementId: materialized.materializableElementId,
      flowLineCount: materialized.flowLineCount,
      drainageZoneCount: materialized.drainageZoneCount,
      rainfallDepthInches:
        typeof ps?.rainfallDepthInches === "number"
          ? (ps.rainfallDepthInches as number)
          : null,
      forcingSource:
        typeof ps?.rainfallForcingSource === "string"
          ? (ps.rainfallForcingSource as string)
          : null,
      reusedExisting: true,
    };
  }

  let demBytes: Buffer;
  try {
    demBytes = await storage.getObjectEntityBytes(topoPayload.dem.gcsObjectPath);
  } catch (err) {
    return {
      status: "upstream-error",
      reason: err instanceof Error ? err.message : String(err),
      code: "dem-download-failed",
    };
  }

  let parsed;
  try {
    parsed = await parseDemBytes(new Uint8Array(demBytes));
  } catch (err) {
    return {
      status: "upstream-error",
      reason: err instanceof Error ? err.message : String(err),
      code: "geotiff-parse-failed",
    };
  }

  const demArrayBuffer = demBytes.buffer.slice(
    demBytes.byteOffset,
    demBytes.byteOffset + demBytes.byteLength,
  ) as ArrayBuffer;

  const hydrology = await runHydrologyWorker({
    demBytes: demArrayBuffer,
    pourLng: pour.lng,
    pourLat: pour.lat,
    catchmentBbox,
    width: parsed.width,
    height: parsed.height,
    elevation: parsed.values,
    rainfallDepthMm,
    accumulationThreshold: accThreshold,
  });

  if (hydrology.status !== "ok") {
    return {
      status: "upstream-error",
      reason: hydrology.message,
      code: hydrology.code,
    };
  }

  const flowLineCount = hydrology.flowLinesGeoJson.features.length;
  const drainageZoneCount = hydrology.drainageZonesGeoJson.features.length;
  const computedAt = new Date().toISOString();
  const eventType: SiteDrainageEventType = latestDrainage
    ? "site-drainage.refreshed"
    : "site-drainage.computed";

  const payload: SiteDrainageEventPayload = {
    schemaVersion: 1,
    computedOrigin: true,
    aiOrigin: false,
    computedAt,
    siteTopography: {
      atomEventId: topo.atomEventId,
      demGcsObjectPath: topoPayload.dem.gcsObjectPath,
      inputSignature: topoPayload.inputSignature,
    },
    catchment: { bbox: catchmentBbox },
    hydrology: {
      library: hydrology.library,
      libraryVersion: hydrology.libraryVersion,
      routing: hydrology.routing,
      accumulationThreshold: hydrology.accumulationThreshold,
      flowLineCount,
      drainageZoneCount,
      pourPoint: hydrology.pourPoint,
    },
    rainfall: {
      depthInches: rainfallForcing.depthInches,
      depthMm: rainfallDepthMm,
      forcingSource: forcingSourceLabel(rainfallForcing),
      forcingDetail: rainfallForcing,
      returnPeriodYears:
        rainfallForcing.kind !== "manual"
          ? rainfallForcing.returnPeriodYears
          : undefined,
    },
    outputs: {
      drainageZonesGeoJson: hydrology.drainageZonesGeoJson,
      flowLinesGeoJson: hydrology.flowLinesGeoJson,
      rainfallResultGeoJson: hydrology.rainfallResultGeoJson,
    },
    inputSignature: signature,
    workerVersion: WORKER_VERSION,
    ...(latestDrainage ? { previousAtomEventId: latestDrainage.id } : {}),
  };

  let atomEventId: string;
  try {
    const appended = await args.history.appendEvent({
      entityType: "site-drainage",
      entityId: args.engagementId,
      eventType,
      actor: { kind: "system", id: SITE_DRAINAGE_INGEST_ACTOR_ID },
      payload: payload as unknown as Record<string, unknown>,
    });
    atomEventId = appended.id;
  } catch (err) {
    return {
      status: "upstream-error",
      reason: err instanceof Error ? err.message : String(err),
      code: "atom-append-failed",
    };
  }

  const materialized = await materializeSiteDrainageFromEvent({
    engagementId: args.engagementId,
    atomEventId,
    payload,
    log,
  });
  if (materialized.status !== "ok") {
    return {
      status: "upstream-error",
      reason: materialized.reason,
      code: "materializer-failed",
    };
  }

  return {
    status: "ok",
    atomEventId,
    eventType,
    materializableElementId: materialized.materializableElementId,
    flowLineCount,
    drainageZoneCount,
    rainfallDepthInches: rainfallForcing.depthInches,
    forcingSource: forcingSourceLabel(rainfallForcing),
    reusedExisting: false,
  };
}

export { SITE_DRAINAGE_EVENT_TYPES };
