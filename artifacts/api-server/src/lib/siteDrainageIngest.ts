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
  rainfallForcingDepthMm,
  type BboxWgs84,
  type RainfallForcingSource,
} from "@workspace/site-context/server";
import { formatEngineSpineFailure } from "./engineSpineClient";
import {
  routeResolveRainfallForcing,
  routeRunHydrologyWorker,
} from "./engineSpineHydrology";
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
    /** True when the pysheds worker was unavailable and native D8 ran. */
    degraded?: boolean;
    degradedReason?: string;
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
  jurisdictionTenant?: string | null;
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

/** Bound for the GCS DEM download (the one await with no native timeout). */
const DEM_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.SITE_DRAINAGE_DEM_DOWNLOAD_TIMEOUT_MS ?? 60_000,
);

export class PhaseTimeoutError extends Error {
  constructor(label: string, budgetMs: number) {
    super(`${label} exceeded ${budgetMs}ms`);
    this.name = "PhaseTimeoutError";
  }
}

async function withPhaseTimeout<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PhaseTimeoutError(label, budgetMs)),
      budgetMs,
    );
  });
  // Swallow the orphan's rejection if the timeout wins the race.
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  const spineCtx = { jurisdictionTenant: args.jurisdictionTenant ?? null };

  // Phase timing — the 2026-07-14 live incident was a drainage run that
  // exceeded 180s with no way to tell which await ate the budget. Every
  // phase is stamped and logged at the end (and on the failure paths the
  // partial map rides along in the reason).
  const phaseStart = Date.now();
  let phaseMark = phaseStart;
  const phaseMs: Record<string, number> = {};
  const markPhase = (name: string): void => {
    const now = Date.now();
    phaseMs[name] = now - phaseMark;
    phaseMark = now;
  };

  let rainfallForcing: RainfallForcingSource;
  try {
    rainfallForcing = await routeResolveRainfallForcing(
      {
        lat: pour.lat,
        lng: pour.lng,
        manualDepthInches: args.manualDepthInches,
        returnPeriodYears: args.returnPeriodYears,
        useCotalityForcing: args.useCotalityForcing ?? false,
        cotalityForcing: null,
      },
      spineCtx,
    );
  } catch (err) {
    const { code, message } = formatEngineSpineFailure(err);
    return {
      status: "upstream-error",
      reason: `engine-api rainfall-forcing failed (${code}): ${message}`,
      code: "engine-api-unreachable",
    };
  }
  markPhase("rainfallForcing");
  const rainfallDepthMm = rainfallForcingDepthMm(rainfallForcing);

  const latestDrainage = await args.history.latestEvent({
    kind: "atom",
    entityType: "site-drainage",
    entityId: args.engagementId,
  });
  markPhase("latestEvent");

  // GCS download bounded — an unbounded storage stream was the one await
  // in this pipeline with no timeout of its own.
  let demBytes: Buffer;
  try {
    demBytes = await withPhaseTimeout(
      storage.getObjectEntityBytes(topoPayload.dem.gcsObjectPath),
      DEM_DOWNLOAD_TIMEOUT_MS,
      `DEM download from ${topoPayload.dem.gcsObjectPath}`,
    );
  } catch (err) {
    return {
      status: "upstream-error",
      reason: err instanceof Error ? err.message : String(err),
      code:
        err instanceof PhaseTimeoutError
          ? "dem-download-timeout"
          : "dem-download-failed",
    };
  }
  markPhase("demDownload");

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
  markPhase("demParse");

  // Threshold must reflect the parsed DEM grid — topo stores the USGS
  // request size (bbox × resolution), which can exceed the returned raster
  // (mocked tests, clipped tiles). Using request dims yields threshold 50
  // on a 10×10 clip where max D8 acc ≈ 9 and no flow lines emit.
  const accThreshold = resolveAccumulationThreshold(
    parsed.width,
    parsed.height,
    args.accumulationThreshold,
  );

  const signature = inputSignature({
    topoSignature: topoPayload.inputSignature,
    rainfallDepthMm,
    accThreshold,
    forcing: forcingSourceLabel(rainfallForcing),
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

  const demArrayBuffer = demBytes.buffer.slice(
    demBytes.byteOffset,
    demBytes.byteOffset + demBytes.byteLength,
  ) as ArrayBuffer;

  let hydrology: Awaited<ReturnType<typeof routeRunHydrologyWorker>>;
  try {
    hydrology = await routeRunHydrologyWorker(
      {
        demBytes: demArrayBuffer,
        pourLng: pour.lng,
        pourLat: pour.lat,
        catchmentBbox,
        width: parsed.width,
        height: parsed.height,
        elevation: parsed.values,
        rainfallDepthMm,
        accumulationThreshold: accThreshold,
      },
      spineCtx,
    );
  } catch (err) {
    const { code, message } = formatEngineSpineFailure(err);
    return {
      status: "upstream-error",
      reason: `engine-api hydrology drainage failed (${code}): ${message} (phaseMs=${JSON.stringify(phaseMs)})`,
      code: "engine-api-unreachable",
    };
  }
  markPhase("engineDrainage");

  if (hydrology.status !== "ok") {
    return {
      status: "upstream-error",
      reason: hydrology.message,
      code: hydrology.code,
    };
  }

  log.info(
    {
      engagementId: args.engagementId,
      phaseMs,
      totalMs: Date.now() - phaseStart,
      demBytes: demBytes.byteLength,
      demGrid: `${parsed.width}x${parsed.height}`,
      library: hydrology.library,
      fallbackUsed: hydrology.fallbackUsed ?? false,
    },
    "site-drainage ingest: phase timings",
  );

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
      ...(hydrology.fallbackUsed
        ? {
            degraded: true,
            degradedReason:
              hydrology.fallbackReason ??
              "pysheds unavailable; native D8 fallback",
          }
        : {}),
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
