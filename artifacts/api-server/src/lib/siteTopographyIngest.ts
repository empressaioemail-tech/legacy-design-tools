/**
 * Site-topography DEM ingest worker — Phase 2D.x PR3.
 *
 * Resolves a parcel boundary from the engagement's active
 * `briefing_sources` (Regrid-emitted GeoJSON post-PR #104), expands
 * to a parcel-plus-catchment bbox, fetches a clipped DEM raster from
 * USGS 3DEP via the PR #98 client, derives contour-line GeoJSON via
 * `d3-contour` over the parsed GeoTIFF elevation grid, uploads the
 * raw raster to GCS, and emits a `site-topography.ingested` (or
 * `.refreshed`) atom event whose payload carries the GCS reference,
 * the contour FeatureCollection, the parcel + catchment bbox, the
 * derivation parameters, and the freshness markers downstream
 * consumers need.
 *
 * Persistence path
 * ----------------
 *
 * `atom_events` is the source of truth — every successful derivation
 * appends one row. `materializable_elements` is a materialized read
 * model populated from the latest event by the companion
 * `siteTopographyMaterializer.ts`. Replay-from-events recovers the
 * read row if it's missing or stale.
 *
 * Worker invocation
 * -----------------
 *
 * Synchronous from a dedicated route handler
 * (`POST /api/engagements/:id/site-topography/refresh`) per the
 * dispatch's "your call" on the invocation model. Per-parcel
 * derivation time at 1km² + 10m DEM is ~3-6s on the canary
 * engagements (Musgrave_Residence_B, Redd). That fits inside a single
 * Cloud Run request timeout without needing a background queue;
 * if the time profile grows past ~10s in production we can wrap the
 * worker in a Cloud Run Job or a Pub/Sub-triggered service in a
 * follow-on PR without changing the worker surface.
 *
 * Idempotency
 * -----------
 *
 * The worker reads the engagement's latest `site-topography` event
 * before ingesting and compares the new derivation's input
 * signature (parcel-geometry hash + DEM source + contour interval)
 * against it. Identical inputs → skip the upstream call, return the
 * existing atom event id. Different inputs → append a `.refreshed`
 * event (carrying `previousAtomEventId` for the supersession chain)
 * and re-materialize. The materializable_elements row supersedes the
 * prior one via the standard engagement-scoped pattern from
 * `ifcIngest.ts` (one active row per engagement; prior generations
 * stamped `superseded_at`).
 */

import { contours as d3Contours } from "d3-contour";
import { fromArrayBuffer as geotiffFromArrayBuffer } from "geotiff";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  briefingSources,
  materializableElements,
  engagements as engagementsTable,
} from "@workspace/db";
import {
  Usgs3depFetchError,
  type BboxWgs84,
  type FetchUsgs3depDemResult,
} from "@workspace/site-context/server";
import { routeFetchUsgs3depDem } from "./engineSpineHydrology";
import type { EventAnchoringService } from "@hauska/atom-contract";
import { SITE_TOPOGRAPHY_INGEST_ACTOR_ID } from "@workspace/server-actor-ids";
import { ObjectStorageService } from "./objectStorage";
import { logger as defaultLogger } from "./logger";
import {
  SITE_TOPOGRAPHY_EVENT_TYPES,
  type SiteTopographyEventType,
} from "../atoms/site-topography.atom";

/**
 * Default contour interval in meters. 5m is the operator-set Phase
 * 2D.x default — fine-grained enough to read terrain shape on a
 * residential-scale parcel at 10m DEM resolution, coarse enough that
 * the GeoJSON payload doesn't blow past ~50 KB per engagement. The
 * route can override per-call when a tighter (or coarser) reading is
 * wanted (e.g. 1m for a flat parcel, 10m for steep terrain).
 */
export const DEFAULT_CONTOUR_INTERVAL_METERS = 5;

/**
 * Default catchment buffer in meters around the parcel boundary.
 * Phase 2D.x spec sets this at 500m as a pragmatic proxy for the
 * upstream-catchment extent (real catchment computation lives in
 * Phase 2D.2's hydrology layer; until then a fixed buffer covers the
 * worst-case parcel-scale runoff catchment within the architect's
 * site-context purview).
 */
export const DEFAULT_CATCHMENT_BUFFER_METERS = 500;

/**
 * Default DEM resolution in meters per pixel. 10m matches USGS 3DEP's
 * 1/3 arc-second national fallback — the resolution that's available
 * for every CONUS parcel today. 1m is regional and would deliver
 * sharper contours where staged, at the cost of a 100× larger raster
 * payload. The route can override when a paid-plan engagement opts in
 * to the higher resolution.
 */
export const DEFAULT_DEM_RESOLUTION_METERS = 10;

/**
 * Bytes-on-the-wire / atom-events JSON payload cap for the contour
 * FeatureCollection. 1 MB is generous for parcel-scale extents at
 * 5m intervals — exceeding it implies a misconfiguration (overly
 * tight interval, overly wide catchment, or low-resolution DEM) and
 * the worker fails loudly rather than silently truncating.
 */
const MAX_CONTOUR_GEOJSON_BYTES = 1_048_576;

/** Layer kinds the parcel resolver inspects, in priority order. */
const PARCEL_LAYER_KINDS_BY_PRIORITY: ReadonlyArray<string> = [
  "regrid-parcel", // National Regrid baseline (PR #104) — preferred
  "grand-county-ut-parcels", // County-GIS for partner cities (Bastrop is partner-only on the parcels side; Grand County gated off baseline)
  "ugrc-parcels", // State-tier UGRC fallback for Utah
];

/** GeoJSON-ish geometry shapes the resolver accepts. */
interface GeoJsonGeometry {
  type: "Polygon" | "MultiPolygon" | string;
  coordinates: unknown;
}

interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJsonGeometry;
  properties?: Record<string, unknown> | null;
}

/** Bbox-shaped fallback (e.g. when payload carries `bbox` but not geometry). */
interface PayloadBbox {
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

interface ResolvedParcelInput {
  /** Provenance flag — which source the parcel boundary came from. */
  origin: "regrid-parcel" | "county-gis-parcel" | "engagement-geocode-fallback";
  /** Slug of the briefing_sources row, when applicable. */
  briefingSourceId: string | null;
  layerKind: string | null;
  /** GeoJSON geometry of the parcel — `Polygon` or `MultiPolygon`. */
  geometry: GeoJsonGeometry | null;
  /**
   * Parcel-only bbox in WGS84 (before catchment buffer). Always populated
   * from `geometry` when available; falls back to the engagement
   * geocode + a small buffer when no parcel geometry exists for the
   * engagement (rare post-Regrid; mostly the out-of-trial-coverage path).
   */
  parcelBbox: BboxWgs84;
}

/** Top-level ingest result envelope. */
export type SiteTopographyIngestResult =
  | {
      status: "ok";
      atomEventId: string;
      atomEventChainHash: string;
      eventType: SiteTopographyEventType;
      materializableElementId: string;
      demGcsObjectPath: string;
      contourCount: number;
      contourIntervalMeters: number;
      parcelOrigin: ResolvedParcelInput["origin"];
      parcelBbox: BboxWgs84;
      catchmentBbox: BboxWgs84;
      demResolutionMeters: number;
      reusedExisting: false;
    }
  | {
      status: "ok";
      atomEventId: string;
      atomEventChainHash: string;
      eventType: SiteTopographyEventType;
      materializableElementId: string;
      demGcsObjectPath: string;
      contourCount: number;
      contourIntervalMeters: number;
      parcelOrigin: ResolvedParcelInput["origin"];
      parcelBbox: BboxWgs84;
      catchmentBbox: BboxWgs84;
      demResolutionMeters: number;
      reusedExisting: true;
    }
  | {
      status: "no-parcel-coverage";
      reason: string;
    }
  | {
      status: "upstream-error";
      reason: string;
      code:
        | "usgs3dep-unavailable"
        | "usgs3dep-timeout"
        | "usgs3dep-non-image"
        | "usgs3dep-aborted"
        | "geotiff-parse-failed"
        | "contour-derivation-failed"
        | "storage-upload-failed"
        | "atom-event-append-failed"
        | "materializer-failed";
      diagnosticEventId?: string;
    };

export interface SiteTopographyIngestArgs {
  engagementId: string;
  history: EventAnchoringService;
  /** ADR-005 jurisdiction partition for spine hydrology/topography calls. */
  jurisdictionTenant?: string | null;
  contourIntervalMeters?: number;
  catchmentBufferMeters?: number;
  demResolutionMeters?: number;
  /** Force re-ingest even when the input signature matches the latest event. */
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Storage shim. Tests inject a stub that writes to an in-memory
   * Map keyed by object path. Defaults to a real ObjectStorageService.
   */
  storage?: SiteTopographyStorageShim;
  log?: typeof defaultLogger;
}

/**
 * Narrow storage interface — the worker only needs to write a single
 * binary blob and surface its `/objects/<id>` path. `ObjectStorageService.
 * uploadObjectEntityFromBuffer` matches; tests can implement the same
 * single-method shape against a Map.
 */
export interface SiteTopographyStorageShim {
  uploadObjectEntityFromBuffer(
    bytes: Buffer | Uint8Array,
    contentType: string,
  ): Promise<string>;
}

function defaultStorage(): SiteTopographyStorageShim {
  return new ObjectStorageService();
}

/** SHA-256 hash of a JSON-stable serialization. Used for the input signature. */
function inputSignature(input: {
  parcelGeometry: GeoJsonGeometry | null;
  catchmentBbox: BboxWgs84;
  demResolutionMeters: number;
  contourIntervalMeters: number;
  demSource: string;
}): string {
  const stable = JSON.stringify({
    p: input.parcelGeometry,
    c: input.catchmentBbox,
    r: input.demResolutionMeters,
    i: input.contourIntervalMeters,
    s: input.demSource,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Recursively walk a GeoJSON coordinate tree and accumulate the WGS84
 * lng/lat extrema. Used to derive the parcel bbox before buffering.
 * Returns null when no finite coordinate was found (degenerate / empty
 * geometry).
 */
export function geometryToBboxWgs84(
  geometry: GeoJsonGeometry,
): BboxWgs84 | null {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  function visit(coords: unknown): void {
    if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === "number") {
      const lng = coords[0] as number;
      const lat = coords[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < west) west = lng;
        if (lng > east) east = lng;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      return;
    }
    if (Array.isArray(coords)) {
      for (const c of coords) visit(c);
    }
  }
  visit(geometry.coordinates);
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

/**
 * Expand a bbox by `meters` on every side. Approximate — uses 111,320
 * m/deg latitude and the cosine-of-mean-latitude scaling for longitude.
 * Sufficient for the parcel-scale extents this worker handles; the
 * scaling error vanishes well within USGS 3DEP's pixel grid.
 */
export function bufferBbox(bbox: BboxWgs84, meters: number): BboxWgs84 {
  const meanLat = (bbox.southLat + bbox.northLat) / 2;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.max(cosLat, 0.01));
  return {
    westLng: bbox.westLng - dLng,
    southLat: bbox.southLat - dLat,
    eastLng: bbox.eastLng + dLng,
    northLat: bbox.northLat + dLat,
  };
}

/**
 * Inspect a `briefing_sources.payload` value for a usable parcel
 * geometry. Looks first at `payload.parcel.geometry` as a full GeoJSON
 * Feature wrapper (Regrid emits this); falls back to ArcGIS-style
 * `geometry.rings` (the county-GIS shape) and rewraps it as GeoJSON
 * Polygon coordinates so the downstream consumers all see one shape.
 * Returns null when no usable geometry is present.
 */
export function extractParcelGeometryFromPayload(
  payload: unknown,
): GeoJsonGeometry | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { parcel?: unknown };
  if (!p.parcel || typeof p.parcel !== "object") return null;
  const parcel = p.parcel as {
    type?: unknown;
    geometry?: unknown;
  };
  // Regrid — `parcel` is a full GeoJSON Feature with nested geometry.
  if (parcel.type === "Feature" && parcel.geometry && typeof parcel.geometry === "object") {
    const g = parcel.geometry as GeoJsonGeometry;
    if (
      (g.type === "Polygon" || g.type === "MultiPolygon") &&
      Array.isArray(g.coordinates)
    ) {
      return g;
    }
  }
  // ArcGIS-style — `parcel.geometry.rings` is the polygon ring set.
  if (parcel.geometry && typeof parcel.geometry === "object") {
    const g = parcel.geometry as { rings?: unknown };
    if (Array.isArray(g.rings) && g.rings.length > 0) {
      return {
        type: "Polygon",
        coordinates: g.rings,
      };
    }
  }
  return null;
}

/**
 * Resolve the most-relevant parcel boundary for an engagement. Reads
 * the active (non-superseded) briefing_sources rows in priority order
 * — Regrid first, then per-county-GIS, then UGRC fallback — and
 * returns the first usable geometry. If none are present, falls back
 * to a small bbox around the engagement geocode. Returns null only
 * when even the geocode is unavailable.
 */
export async function resolveParcelInput(
  engagementId: string,
): Promise<ResolvedParcelInput | null> {
  const rows = await db
    .select({
      id: briefingSources.id,
      layerKind: briefingSources.layerKind,
      payload: briefingSources.payload,
    })
    .from(briefingSources)
    .innerJoin(
      // parcel_briefings.engagement_id → briefingSources.briefingId
      // We need a join through parcel_briefings to scope by engagement.
      // Drizzle's relation graph already encodes this; we use a manual
      // join here for read-clarity.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@workspace/db")).parcelBriefings as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq(briefingSources.briefingId, (await import("@workspace/db")).parcelBriefings.id as any),
    )
    .where(
      and(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eq((await import("@workspace/db")).parcelBriefings.engagementId as any, engagementId),
        isNull(briefingSources.supersededAt),
      ),
    );
  // Sort by priority — lower index in PARCEL_LAYER_KINDS_BY_PRIORITY wins.
  const ranked = rows
    .map((r) => ({
      ...r,
      priority: PARCEL_LAYER_KINDS_BY_PRIORITY.indexOf(r.layerKind),
    }))
    .filter((r) => r.priority >= 0)
    .sort((a, b) => a.priority - b.priority);

  for (const row of ranked) {
    const geometry = extractParcelGeometryFromPayload(row.payload);
    if (!geometry) continue;
    const bbox = geometryToBboxWgs84(geometry);
    if (!bbox) continue;
    return {
      origin:
        row.layerKind === "regrid-parcel" ? "regrid-parcel" : "county-gis-parcel",
      briefingSourceId: row.id,
      layerKind: row.layerKind,
      geometry,
      parcelBbox: bbox,
    };
  }

  // Final fallback — engagement geocode + small buffer. Useful for the
  // out-of-Regrid-coverage cases (trial token + unzoned tracts) so the
  // worker still produces a topo overlay anchored at the address.
  const eng = await db
    .select({
      latitude: engagementsTable.latitude,
      longitude: engagementsTable.longitude,
    })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, engagementId))
    .limit(1);
  const e = eng[0];
  if (
    !e ||
    e.latitude === null ||
    e.longitude === null ||
    !Number.isFinite(Number(e.latitude)) ||
    !Number.isFinite(Number(e.longitude))
  ) {
    return null;
  }
  const lat = Number(e.latitude);
  const lng = Number(e.longitude);
  // ~200m square around the geocode — a residential-parcel-scale
  // anchor so the topo overlay reads at the right zoom even without a
  // real parcel polygon.
  const parcelBbox = bufferBbox(
    { westLng: lng, southLat: lat, eastLng: lng, northLat: lat },
    200,
  );
  return {
    origin: "engagement-geocode-fallback",
    briefingSourceId: null,
    layerKind: null,
    geometry: null,
    parcelBbox,
  };
}

/**
 * Parse a GeoTIFF byte buffer into a 2D elevation grid + dimensions.
 * Uses the `geotiff` npm library (pure JS, no native deps). The first
 * raster band is the DEM elevation in meters; the worker treats values
 * below `-1e30` (USGS 3DEP nodata sentinel) as missing.
 */
export interface ParsedDem {
  width: number;
  height: number;
  /** Row-major elevation values; nodata cells are NaN. */
  values: Float32Array;
  /** Min/max of finite values for quick contour-level seeding. */
  minElevation: number;
  maxElevation: number;
  /** Count of nodata / nan cells, surfaced for diagnostic log lines. */
  nodataCount: number;
}

export async function parseDemBytes(bytes: Uint8Array): Promise<ParsedDem> {
  const tiff = await geotiffFromArrayBuffer(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const band0 = Array.isArray(rasters) ? rasters[0] : rasters;
  // geotiff returns one of several TypedArray flavours depending on
  // the GeoTIFF's pixel type. Normalise to Float32 with NaN-encoded
  // nodata so the downstream contour code only has to handle one
  // shape.
  const width = image.getWidth();
  const height = image.getHeight();
  const total = width * height;
  const values = new Float32Array(total);
  let min = Infinity;
  let max = -Infinity;
  let nodataCount = 0;
  for (let i = 0; i < total; i++) {
    const raw = Number((band0 as ArrayLike<number>)[i]);
    // USGS 3DEP nodata sentinel is ~ -3.4028235e38 (FLT_MIN). Treat
    // any value below -1e30 as nodata for robustness across drivers.
    if (!Number.isFinite(raw) || raw <= -1e30) {
      values[i] = Number.NaN;
      nodataCount++;
      continue;
    }
    values[i] = raw;
    if (raw < min) min = raw;
    if (raw > max) max = raw;
  }
  if (!Number.isFinite(min)) {
    // Every cell was nodata — surface as parse error, the upstream is
    // either misconfigured or the bbox sits entirely off-coverage.
    throw new Error(
      `DEM contained no finite elevation values (${nodataCount}/${total} cells nodata).`,
    );
  }
  return {
    width,
    height,
    values,
    minElevation: min,
    maxElevation: max,
    nodataCount,
  };
}

/**
 * Derive contour-line GeoJSON from a parsed DEM. Uses `d3-contour`
 * (Marching Squares) which outputs MultiPolygon features in *pixel*
 * coordinate space; we remap to WGS84 lng/lat using the DEM's bbox so
 * the FeatureCollection drops straight onto Leaflet's
 * `L.GeoJSON` layer without a per-vertex coordinate transform on the
 * client.
 *
 * Pure function — no DB or HTTP calls. Unit-tested directly against a
 * synthetic elevation grid.
 */
export function deriveContoursGeoJson(
  dem: ParsedDem,
  bbox: BboxWgs84,
  intervalMeters: number,
): {
  featureCollection: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: GeoJsonGeometry;
      properties: { elevationMeters: number };
    }>;
  };
  thresholds: number[];
} {
  // Replace NaN with min-elevation so the marching-squares algorithm
  // doesn't propagate NaN into intermediate sums. The contour lines at
  // the nodata boundary read as the lowest-level isoline; this is the
  // same convention `gdal_contour -inodata` uses by default.
  const replaced = new Float64Array(dem.values.length);
  for (let i = 0; i < dem.values.length; i++) {
    const v = dem.values[i]!;
    replaced[i] = Number.isFinite(v) ? v : dem.minElevation;
  }
  // Build the threshold ladder anchored at integer multiples of the
  // interval. Anchoring to integer-multiples (rather than the bbox's
  // own min/max) means re-running with a slightly different parcel
  // bbox yields the same threshold levels — the contours stay
  // stable across re-ingests of the same parcel even if the bbox
  // shifts by a few pixels.
  const startElev = Math.ceil(dem.minElevation / intervalMeters) * intervalMeters;
  const endElev = Math.floor(dem.maxElevation / intervalMeters) * intervalMeters;
  const thresholds: number[] = [];
  for (let v = startElev; v <= endElev; v += intervalMeters) {
    thresholds.push(v);
  }

  if (thresholds.length === 0) {
    // Degenerate — flat or very-narrow elevation range. Return an
    // empty collection rather than throwing; the consumer renders no
    // contours but the worker still emits a valid atom event.
    return {
      featureCollection: { type: "FeatureCollection", features: [] },
      thresholds: [],
    };
  }

  const generator = d3Contours()
    .size([dem.width, dem.height])
    .thresholds(thresholds);
  const rawContours = generator(replaced as unknown as number[]);

  // Pixel → lng/lat remap. Raster Y grows downward (row 0 is the
  // north edge) so we flip when remapping.
  const dLng = (bbox.eastLng - bbox.westLng) / dem.width;
  const dLat = (bbox.northLat - bbox.southLat) / dem.height;
  function remapPair(pair: ArrayLike<number>): [number, number] {
    const px = pair[0]!;
    const py = pair[1]!;
    const lng = bbox.westLng + px * dLng;
    const lat = bbox.northLat - py * dLat;
    return [lng, lat];
  }

  const features = rawContours.map((c) => {
    const remapped = (c.coordinates as unknown as number[][][][]).map(
      (polygon) => polygon.map((ring) => ring.map(remapPair)),
    );
    return {
      type: "Feature" as const,
      geometry: {
        type: "MultiPolygon",
        coordinates: remapped,
      } as GeoJsonGeometry,
      properties: { elevationMeters: c.value },
    };
  });

  return {
    featureCollection: { type: "FeatureCollection", features },
    thresholds,
  };
}

/** Site-topography event payload shape. Pinned to the atom registration. */
export interface SiteTopographyEventPayload {
  schemaVersion: 1;
  /** Marker per ADR-001 — deterministic geospatial computation, not LLM. */
  computedOrigin: true;
  aiOrigin: false;
  /**
   * Provenance of the parcel boundary that drove the derivation.
   * Lets a future re-derivation reuse the same boundary or detect a
   * boundary change.
   */
  parcel: {
    origin: ResolvedParcelInput["origin"];
    briefingSourceId: string | null;
    layerKind: string | null;
    geometry: GeoJsonGeometry | null;
    parcelBbox: BboxWgs84;
  };
  catchment: {
    bufferMeters: number;
    bbox: BboxWgs84;
  };
  dem: {
    source: "usgs-3dep";
    resolutionMeters: number;
    /** Object storage path the worker uploaded the GeoTIFF to. */
    gcsObjectPath: string;
    /** USGS request URL (for replay). */
    endpoint: string;
    /** Wall-clock time the upstream call started — proxy for acquisition. */
    fetchedAt: string;
    widthPx: number;
    heightPx: number;
    minElevation: number;
    maxElevation: number;
    nodataCount: number;
  };
  contours: {
    intervalMeters: number;
    thresholds: number[];
    featureCount: number;
    /** Inline GeoJSON. Capped by MAX_CONTOUR_GEOJSON_BYTES at write time. */
    featureCollection: {
      type: "FeatureCollection";
      features: ReadonlyArray<{
        type: "Feature";
        geometry: GeoJsonGeometry;
        properties: { elevationMeters: number };
      }>;
    };
  };
  /** Hash of the inputs that produced this payload. */
  inputSignature: string;
  /** Worker version — bump when the algorithm changes. */
  workerVersion: string;
  /** Pointer to the prior event for `.refreshed` events. */
  previousAtomEventId?: string;
}

const WORKER_VERSION = "site-topography-ingest@1.0.0";

interface LatestEventSummary {
  id: string;
  eventType: SiteTopographyEventType;
  occurredAt: Date;
  /** Pulled from payload.inputSignature when present. */
  inputSignature: string | null;
}

async function loadLatestEvent(
  history: EventAnchoringService,
  engagementId: string,
): Promise<LatestEventSummary | null> {
  try {
    const latest = await history.latestEvent({
      kind: "atom",
      entityType: "site-topography",
      entityId: engagementId,
    });
    if (!latest) return null;
    const payload = latest.payload as Partial<SiteTopographyEventPayload> & {
      inputSignature?: unknown;
    };
    const sig =
      typeof payload?.inputSignature === "string" ? payload.inputSignature : null;
    return {
      id: latest.id,
      eventType: latest.eventType as SiteTopographyEventType,
      occurredAt: latest.occurredAt,
      inputSignature: sig,
    };
  } catch {
    // Best-effort — a transient history outage falls through to a
    // live re-ingest; idempotency is best-effort, not load-bearing.
    return null;
  }
}

/**
 * End-to-end DEM ingest. Resolves parcel → expands catchment bbox →
 * fetches DEM → parses → contours → uploads → appends event →
 * materializes read row. Per-stage failures throw typed
 * `SiteTopographyIngestError` carrying the stable `code` the route
 * surfaces in its response.
 *
 * Materialization is invoked here for the success path (it's a
 * single-row write atop the same DB connection). Replay-from-events
 * lives in `siteTopographyMaterializer.ts` for the
 * `materializable_elements` row missing case.
 */
export async function ingestSiteTopography(
  args: SiteTopographyIngestArgs,
): Promise<SiteTopographyIngestResult> {
  const log = args.log ?? defaultLogger;
  const contourIntervalMeters =
    args.contourIntervalMeters ?? DEFAULT_CONTOUR_INTERVAL_METERS;
  const catchmentBufferMeters =
    args.catchmentBufferMeters ?? DEFAULT_CATCHMENT_BUFFER_METERS;
  const demResolutionMeters =
    args.demResolutionMeters ?? DEFAULT_DEM_RESOLUTION_METERS;
  const storage = args.storage ?? defaultStorage();

  // 1) Resolve parcel boundary.
  const parcel = await resolveParcelInput(args.engagementId);
  if (!parcel) {
    log.warn(
      { engagementId: args.engagementId },
      "site-topography ingest: no parcel + no engagement geocode — skipping",
    );
    return {
      status: "no-parcel-coverage",
      reason:
        "No active regrid-parcel / county-gis-parcel / ugrc-parcels briefing-source and no engagement geocode — cannot derive a topo extent.",
    };
  }
  const catchmentBbox = bufferBbox(parcel.parcelBbox, catchmentBufferMeters);

  // 2) Idempotency check — compare the input signature with the
  //    latest event. Skip the upstream call when the signature matches
  //    and forceRefresh is false.
  const signature = inputSignature({
    parcelGeometry: parcel.geometry,
    catchmentBbox,
    demResolutionMeters,
    contourIntervalMeters,
    demSource: "usgs-3dep",
  });
  const latestEvent = await loadLatestEvent(args.history, args.engagementId);
  if (
    latestEvent &&
    latestEvent.inputSignature === signature &&
    !args.forceRefresh
  ) {
    log.info(
      {
        engagementId: args.engagementId,
        atomEventId: latestEvent.id,
        signature,
      },
      "site-topography ingest: input signature unchanged — reusing latest event",
    );
    // Re-run the materializer to make sure the read row mirrors the
    // latest event (covers the replay-from-events case where the row
    // was deleted between calls).
    const materialized = await rematerializeFromLatestEvent({
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
    return {
      status: "ok",
      atomEventId: latestEvent.id,
      atomEventChainHash: materialized.chainHash,
      eventType: latestEvent.eventType,
      materializableElementId: materialized.materializableElementId,
      demGcsObjectPath: materialized.demGcsObjectPath,
      contourCount: materialized.contourCount,
      contourIntervalMeters: materialized.contourIntervalMeters,
      parcelOrigin: parcel.origin,
      parcelBbox: parcel.parcelBbox,
      catchmentBbox,
      demResolutionMeters,
      reusedExisting: true,
    };
  }

  // 3) Fetch DEM from USGS 3DEP.
  let demResult: FetchUsgs3depDemResult;
  try {
    demResult = await routeFetchUsgs3depDem(
      catchmentBbox,
      {
        resolutionMeters: demResolutionMeters,
        fetchImpl: args.fetchImpl,
        signal: args.signal,
      },
      { jurisdictionTenant: args.jurisdictionTenant ?? null },
    );
  } catch (err) {
    const code = mapUsgs3depError(err);
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, engagementId: args.engagementId, code, catchmentBbox },
      "site-topography ingest: USGS 3DEP fetch failed",
    );
    return { status: "upstream-error", reason, code };
  }

  // 4) Parse GeoTIFF.
  let dem: ParsedDem;
  try {
    dem = await parseDemBytes(demResult.bytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, engagementId: args.engagementId, endpoint: demResult.endpoint },
      "site-topography ingest: GeoTIFF parse failed",
    );
    return {
      status: "upstream-error",
      reason,
      code: "geotiff-parse-failed",
    };
  }

  // 5) Derive contours.
  let contoursResult: ReturnType<typeof deriveContoursGeoJson>;
  try {
    contoursResult = deriveContoursGeoJson(
      dem,
      catchmentBbox,
      contourIntervalMeters,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, engagementId: args.engagementId },
      "site-topography ingest: contour derivation failed",
    );
    return {
      status: "upstream-error",
      reason,
      code: "contour-derivation-failed",
    };
  }
  // Size guard.
  const geojsonBytes = JSON.stringify(contoursResult.featureCollection).length;
  if (geojsonBytes > MAX_CONTOUR_GEOJSON_BYTES) {
    return {
      status: "upstream-error",
      reason: `Contour FeatureCollection size ${geojsonBytes} exceeds ${MAX_CONTOUR_GEOJSON_BYTES}-byte cap. Widen the contour interval or narrow the catchment.`,
      code: "contour-derivation-failed",
    };
  }

  // 6) Upload DEM bytes to GCS.
  let demGcsObjectPath: string;
  try {
    demGcsObjectPath = await storage.uploadObjectEntityFromBuffer(
      Buffer.from(demResult.bytes),
      "image/tiff",
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, engagementId: args.engagementId },
      "site-topography ingest: DEM storage upload failed",
    );
    return {
      status: "upstream-error",
      reason,
      code: "storage-upload-failed",
    };
  }

  // 7) Append atom event.
  const eventType: SiteTopographyEventType =
    latestEvent === null
      ? SITE_TOPOGRAPHY_EVENT_TYPES[0] // .ingested
      : SITE_TOPOGRAPHY_EVENT_TYPES[1]; // .refreshed

  const payload: SiteTopographyEventPayload = {
    schemaVersion: 1,
    computedOrigin: true,
    aiOrigin: false,
    parcel: {
      origin: parcel.origin,
      briefingSourceId: parcel.briefingSourceId,
      layerKind: parcel.layerKind,
      geometry: parcel.geometry,
      parcelBbox: parcel.parcelBbox,
    },
    catchment: {
      bufferMeters: catchmentBufferMeters,
      bbox: catchmentBbox,
    },
    dem: {
      source: "usgs-3dep",
      resolutionMeters: demResolutionMeters,
      gcsObjectPath: demGcsObjectPath,
      endpoint: demResult.endpoint,
      fetchedAt: demResult.fetchedAt,
      widthPx: demResult.widthPx,
      heightPx: demResult.heightPx,
      minElevation: dem.minElevation,
      maxElevation: dem.maxElevation,
      nodataCount: dem.nodataCount,
    },
    contours: {
      intervalMeters: contourIntervalMeters,
      thresholds: contoursResult.thresholds,
      featureCount: contoursResult.featureCollection.features.length,
      featureCollection: contoursResult.featureCollection,
    },
    inputSignature: signature,
    workerVersion: WORKER_VERSION,
    ...(latestEvent ? { previousAtomEventId: latestEvent.id } : {}),
  };

  let event: { id: string; chainHash: string };
  try {
    event = await args.history.appendEvent({
      entityType: "site-topography",
      entityId: args.engagementId,
      eventType,
      actor: { kind: "system", id: SITE_TOPOGRAPHY_INGEST_ACTOR_ID },
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, engagementId: args.engagementId },
      "site-topography ingest: atom event append failed",
    );
    return {
      status: "upstream-error",
      reason,
      code: "atom-event-append-failed",
    };
  }

  // 8) Materialize the read row from this event.
  const materialized = await materializeSiteTopographyFromEvent({
    engagementId: args.engagementId,
    atomEventId: event.id,
    payload,
    log,
  });
  if (materialized.status !== "ok") {
    return {
      status: "upstream-error",
      reason: materialized.reason,
      code: "materializer-failed",
      diagnosticEventId: event.id,
    };
  }

  log.info(
    {
      engagementId: args.engagementId,
      atomEventId: event.id,
      eventType,
      contourCount: contoursResult.featureCollection.features.length,
      contourIntervalMeters,
      parcelOrigin: parcel.origin,
      reused: false,
    },
    "site-topography ingest: complete",
  );

  return {
    status: "ok",
    atomEventId: event.id,
    atomEventChainHash: event.chainHash,
    eventType,
    materializableElementId: materialized.materializableElementId,
    demGcsObjectPath,
    contourCount: contoursResult.featureCollection.features.length,
    contourIntervalMeters,
    parcelOrigin: parcel.origin,
    parcelBbox: parcel.parcelBbox,
    catchmentBbox,
    demResolutionMeters,
    reusedExisting: false,
  };
}

function mapUsgs3depError(
  err: unknown,
): "usgs3dep-unavailable" | "usgs3dep-timeout" | "usgs3dep-non-image" | "usgs3dep-aborted" {
  if (err instanceof Usgs3depFetchError) {
    if (err.code === "timeout") return "usgs3dep-timeout";
    if (err.code === "aborted") return "usgs3dep-aborted";
    if (err.code === "non-image-response") return "usgs3dep-non-image";
  }
  return "usgs3dep-unavailable";
}

// Re-exported from siteTopographyMaterializer to keep the import surface
// shallow for callers of this module.
import {
  materializeSiteTopographyFromEvent,
  rematerializeFromLatestEvent,
} from "./siteTopographyMaterializer";
