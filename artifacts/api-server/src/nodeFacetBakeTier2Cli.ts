#!/usr/bin/env node
/**
 * Tier-2 node-facet warm-up bake CLI — the LIVE-DEP facet upgrade.
 *
 * Tier 1 (nodeFacetBakeTier1Cli.ts) baked the cheap, deterministic facets
 * (base facts, land-use, zoning, and the buildable envelope computed WITHOUT
 * roads — provisional, `roadsPending: true`) into `place_layer_snapshots` under
 * `node-facets:tier1`. Tier 2 adds the two facets that need a LIVE EXTERNAL
 * FETCH, and it is CACHE-FIRST by construction so a county bake does not hammer
 * OSM/FEMA:
 *
 *   1. ENVELOPE UPGRADE (OSM roads). Re-derive the buildable envelope with
 *      road-based front-edge labeling (the real front edge, not the lot-shape
 *      guess). Higher confidence -> the monotonic guard PROMOTES it. Honest
 *      degradation: a failed/empty road fetch falls back to the centroid
 *      (`point`) or lot-shape (`shape`) signal — never a fabricated road front.
 *   2. FEMA FLOOD (NFHL layer 28). Per-node flood zone (AE/X/VE…), SFHA flag,
 *      BFE, carrying the FEMA vintage. Honest absence: a FEMA outage stores
 *      `unavailable` (never a fabricated zone); a clean empty result stores
 *      `outside-sfha` (a real answer).
 *
 * === STORAGE (the composition choice) ===
 * Tier-2 facets are written to a SEPARATE adapter key `node-facets:tier2`
 * (place_key `node:<parcel_node_id>`, same key scheme as Tier 1). The inspect
 * card composes a node by reading BOTH keys: Tier 1 supplies base facts /
 * land-use / zoning / the provisional envelope, and Tier 2 OVERLAYS the
 * road-upgraded envelope (which wins when present) plus the flood facet. A
 * separate key (rather than mutating the Tier-1 row) keeps each tier's bake
 * idempotent and independently re-runnable, keeps the Tier-1 monotonic guard +
 * fabrication override untouched, and lets a Tier-2 outage never regress a
 * Tier-1 row. The Tier-2 key carries its OWN monotonic guard (tier2FacetScore
 * + shouldPromoteTier2) so a re-bake never downgrades a node's Tier-2 facets.
 *
 * === CACHE-FIRST (the cost control) ===
 * Live OSM/FEMA fetches are SLOW (Overpass ~5s on a clean 200, 504s ~50% of the
 * time; FEMA ~0.5-1s) and RATE-LIMITED. A naive per-parcel live fetch at
 * Tier-1's ~630 nodes/sec is categorically impossible. So Tier 2 batches by
 * TILE:
 *   - ROAD tile: rounded to CACHE_TILE_DEG (0.001 deg ~ 111 m, matching
 *     roads.ts's own cache grid). One Overpass fetch per road tile is REUSED
 *     across every parcel whose centroid rounds into that tile. roads.ts's
 *     internal LRU also caches, so even a cache miss here is deduped there.
 *   - FEMA tile: rounded to FEMA_TILE_DEG (0.005 deg ~ 550 m). FEMA flood
 *     polygons are large + change on a multi-year cadence, so one point-query
 *     per FEMA tile is reused across the tile's parcels.
 * Fetches run at a small fixed CONCURRENCY (Overpass allows 2 slots) with the
 * page's tiles fetched once, then every node in the page composed from the warm
 * tile cache. The measured rate + full-county feasibility is reported at close.
 *
 * HONEST ABSENCE (commitment #1): every live-dep failure degrades, never
 * fabricates. A road outage -> point/shape envelope (labeled with the signal
 * that fired). A FEMA outage -> `unavailable` flood facet. Owner is never
 * selected (same as Tier 1). The Tier-2 monotonic guard keeps the better prior.
 *
 * Usage (from repo root):
 *   pnpm --filter @artifacts/api-server node-facet-bake-tier2 -- \
 *     --county=48055 [--limit=200] [--dry-run] [--page-size=2000] \
 *     [--road-concurrency=2] [--fema-concurrency=4] [--skip-roads] \
 *     [--skip-fema] [--adapter-key=node-facets:tier2]
 *
 *   or directly:
 *   tsx artifacts/api-server/src/nodeFacetBakeTier2Cli.ts --county=48055 \
 *     --limit=200 --dry-run
 *
 * DATABASE_URL must point at the parcel Postgres (falls back to loading the
 * DEPLOYMENT_DATABASE_URL secret via gcloud, same as the Tier-1 bake). This is
 * PROD read; the Tier-2 write in a BOUNDED dry-run/limited run is fine, but do
 * NOT full-prod-bake per-node live at scale — tile the county (see the PR body).
 *
 * Exit-bounded: connect -> per-county paged (tile-fetch + compose + write) ->
 * summary, then exit. Exit 0 on success, 1 on fatal error.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import { parcelNodeId } from "./lib/parcelNodeId";
import { contentHashForPayload } from "./lib/placeLayerUtils";
import { firstRing } from "./nodeFacetBakeTier1Cli";
import { ringCentroid, type Ring } from "./lib/nodeFacetBakeTier1";
import {
  computeTier2Envelope,
  buildFloodFacet,
  tier2FacetScore,
  type Tier2EnvelopeFacet,
  type Tier2FloodFacet,
  type FemaQueryLike,
} from "./lib/nodeFacetBakeTier2";
import {
  fetchNearbyRoads,
  type NamedRoad,
} from "./lib/buildableEnvelope/roads";
import { arcgisPointQuery } from "@workspace/adapters/arcgis";
import type { RoadCandidate } from "./lib/buildableEnvelope/edgeLabeling";

const { Pool } = pg;

export const TIER2_ADAPTER_KEY = "node-facets:tier2";
export const TIER2_FACET_SCHEMA_VERSION = "node-facets-tier2-v1";

const FEMA_NFHL_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

/** Road cache tile (deg) — matches roads.ts CACHE_TILE_DEG (~111 m). */
export const ROAD_TILE_DEG = 0.001;
/** FEMA cache tile (deg) — coarser (~550 m); flood polygons are large. */
export const FEMA_TILE_DEG = 0.005;

const COUNTY_NAMES: Record<string, string> = {
  "48209": "Hays",
  "48091": "Comal",
  "48453": "Travis",
  "48491": "Williamson",
  "48029": "Bexar",
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48187": "Guadalupe",
  "48027": "Bell",
  "48309": "McLennan",
};

const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

function log(msg: string): void {
  console.log(`[node-facet-bake-t2] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[node-facet-bake-t2] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution (identical to the Tier-1 bake).
// ---------------------------------------------------------------------------

function resolveDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env.GCP_PROJECT ?? "legacy-design-tools-prod";
  try {
    const out = execFileSync(
      gcloud,
      [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=DEPLOYMENT_DATABASE_URL",
        `--project=${project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (out) return out;
  } catch (err) {
    fail(
      "DATABASE_URL not set and gcloud secret fetch failed: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return fail("DATABASE_URL could not be resolved");
}

// ---------------------------------------------------------------------------
// County discovery (prod wins over staging; needs zoning_district for envelope).
// ---------------------------------------------------------------------------

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const r = await pool.query<{ r: string | null }>(
    "SELECT to_regclass($1) AS r",
    [table],
  );
  return r.rows[0]?.r != null;
}

async function columnExists(
  pool: pg.Pool,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

interface CountySource {
  fips: string;
  name: string;
  table: string;
  parcelCount: number;
  hasZoning: boolean;
}

async function discoverCounty(
  pool: pg.Pool,
  fips: string,
): Promise<CountySource | null> {
  for (const table of PARCEL_TABLES) {
    if (!(await tableExists(pool, table))) continue;
    const r = await pool.query<{ parcels: string }>(
      `SELECT count(DISTINCT feature_index) AS parcels
         FROM ${table}
        WHERE county_fips = $1`,
      [fips],
    );
    const n = Number(r.rows[0]?.parcels ?? 0);
    if (n > 0) {
      const hasZoning = await columnExists(pool, table, "zoning_district");
      return {
        fips,
        name: COUNTY_NAMES[fips] ?? fips,
        table,
        parcelCount: n,
        hasZoning,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier-2 payload.
// ---------------------------------------------------------------------------

export interface Tier2FacetPayload {
  facetSchemaVersion: string;
  tier: 2;
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  /** The road-upgraded envelope (or an honest declined). Null when no ring. */
  envelope: Tier2EnvelopeFacet | null;
  /** The FEMA flood facet (in-sfha / flood-zone / outside-sfha / unavailable). */
  flood: Tier2FloodFacet;
  provenance: {
    /** Tier 2 has resolved (or attempted) the road signal. */
    roadsPending: false;
    roadSource: "osm-overpass";
    floodSource: "fema-nfhl";
    tierNote: string;
  };
  bakedAt: string;
}

interface ParcelRow {
  feature_index: number;
  prop_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  zoning_district: string | null;
  geometry: unknown;
}

function placeKeyForNode(nodeId: string): string {
  return `node:${nodeId}`;
}

/** Round a coord onto a tile grid; the tile key is the grid cell center. */
function tileKey(lat: number, lng: number, deg: number): string {
  const qLat = Math.round(lat / deg) * deg;
  const qLng = Math.round(lng / deg) * deg;
  return `${qLat.toFixed(5)},${qLng.toFixed(5)}`;
}

function tileCenter(key: string): { lat: number; lng: number } {
  const [lat, lng] = key.split(",").map(Number);
  return { lat: lat!, lng: lng! };
}

// ---------------------------------------------------------------------------
// Monotonic guard for the Tier-2 key (same shape as Tier-1 shouldPromote).
// ---------------------------------------------------------------------------

export interface Tier2Prior {
  envelope: Tier2EnvelopeFacet | null;
  flood: Tier2FloodFacet;
}

/**
 * Promote a fresh Tier-2 payload over a stored prior only when it is at least
 * as good (more resolved facets, ties broken by envelope confidence). A worse
 * re-bake — e.g. a transient FEMA outage on the re-run that would downgrade a
 * real prior flood reading to `unavailable`, or a road fetch that this time
 * failed and dropped the envelope to a shape guess — is REJECTED, keeping the
 * better prior. There is no fabrication-override here: Tier 2 has no
 * gate-blocked-strip case (that is a Tier-1 land-use concern).
 */
export function shouldPromoteTier2(
  prior: Tier2Prior | null,
  next: Tier2Prior,
): boolean {
  if (!prior) return true;
  return tier2FacetScore(next) >= tier2FacetScore(prior);
}

export async function readTier2SnapshotsBatch(
  pool: pg.Pool,
  adapterKey: string,
  placeKeys: string[],
): Promise<Map<string, Tier2Prior>> {
  const out = new Map<string, Tier2Prior>();
  if (placeKeys.length === 0) return out;
  const r = await pool.query<{ place_key: string; payload_json: unknown }>(
    `SELECT place_key, payload_json
       FROM place_layer_snapshots
      WHERE adapter_key = $1 AND place_key = ANY($2)`,
    [adapterKey, placeKeys],
  );
  for (const row of r.rows) {
    const raw = row.payload_json;
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<Tier2FacetPayload>;
    if (!p.flood || !p.parcelNodeId) continue;
    out.set(row.place_key, { envelope: p.envelope ?? null, flood: p.flood });
  }
  return out;
}

export const BATCH_WRITE_CHUNK = 5000;

export function chunkItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface BakeWriteItem {
  placeKey: string;
  centroid: { lat: number; lng: number };
  payload: Tier2FacetPayload;
}

async function writeSnapshotsBatch(
  pool: pg.Pool,
  adapterKey: string,
  items: BakeWriteItem[],
): Promise<void> {
  if (items.length === 0) return;
  const now = new Date();
  for (const chunk of chunkItems(items, BATCH_WRITE_CHUNK)) {
    const placeKeys: string[] = [];
    const lats: string[] = [];
    const lngs: string[] = [];
    const payloads: string[] = [];
    const hashes: string[] = [];
    for (const it of chunk) {
      placeKeys.push(it.placeKey);
      lats.push(it.centroid.lat.toFixed(5));
      lngs.push(it.centroid.lng.toFixed(5));
      payloads.push(JSON.stringify(it.payload));
      hashes.push(
        contentHashForPayload(it.payload as unknown as Record<string, unknown>),
      );
    }
    await pool.query(
      `INSERT INTO place_layer_snapshots
         (place_key, adapter_key, lat_rounded, lng_rounded, ll_uuid,
          payload_json, content_hash, snapshot_at, created_at, updated_at)
       SELECT
          u.place_key, $1, u.lat_rounded::numeric, u.lng_rounded::numeric, NULL,
          u.payload_json::jsonb, u.content_hash, $2, $2, $2
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS u(place_key, lat_rounded, lng_rounded, payload_json, content_hash)
       ON CONFLICT (adapter_key, place_key) DO UPDATE SET
         lat_rounded = EXCLUDED.lat_rounded,
         lng_rounded = EXCLUDED.lng_rounded,
         payload_json = EXCLUDED.payload_json,
         content_hash = EXCLUDED.content_hash,
         snapshot_at = EXCLUDED.snapshot_at,
         updated_at = EXCLUDED.updated_at`,
      [adapterKey, now, placeKeys, lats, lngs, payloads, hashes],
    );
  }
}

// ---------------------------------------------------------------------------
// Tile fetch (cache-first). One fetch per road/FEMA tile, reused across nodes.
// ---------------------------------------------------------------------------

/** Bounded-concurrency map over keys, resolving each via `fn`. */
async function mapConcurrent<K, V>(
  keys: K[],
  concurrency: number,
  fn: (k: K) => Promise<V>,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  let i = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, concurrency);
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = i++;
          if (idx >= keys.length) return;
          const k = keys[idx]!;
          out.set(k, await fn(k));
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

interface TileStats {
  roadTilesFetched: number;
  roadTilesWithRoads: number;
  roadFetchFailures: number;
  femaTilesFetched: number;
  femaOutages: number;
}

/** Convert fetched NamedRoads into labelEdges RoadCandidates. */
function toCandidates(roads: NamedRoad[]): RoadCandidate[] {
  return roads.map((r) => ({ name: r.name, polyline: r.polyline }));
}

/**
 * Fetch the road tile cache for a page: one Overpass fetch per unique road
 * tile, at the tile center, bounded-concurrency. roads.ts already retries +
 * caches internally, so a tile that failed to produce roads is recorded (and
 * the node degrades to the point/shape signal — honest absence). Returns a map
 * tileKey -> RoadCandidate[] (empty array on a failed/empty fetch).
 */
async function fetchRoadTiles(
  tiles: string[],
  concurrency: number,
  timeoutMs: number,
  stats: TileStats,
): Promise<Map<string, RoadCandidate[]>> {
  const raw = await mapConcurrent(tiles, concurrency, async (key) => {
    const c = tileCenter(key);
    stats.roadTilesFetched += 1;
    try {
      const roads = await fetchNearbyRoads({
        lat: c.lat,
        lng: c.lng,
        timeoutMs,
      });
      if (roads.length > 0) stats.roadTilesWithRoads += 1;
      return toCandidates(roads);
    } catch {
      // fetchNearbyRoads never throws by contract, but be defensive: a throw
      // is an honest empty (degrade to point/shape), counted as a failure.
      stats.roadFetchFailures += 1;
      return [] as RoadCandidate[];
    }
  });
  return raw;
}

/**
 * Fetch the FEMA tile cache for a page: one NFHL point-query per unique FEMA
 * tile center, bounded-concurrency. A query THROW (outage / arcgis error) is
 * caught and stored as `null` so the node's flood facet becomes `unavailable`
 * (honest absence — never a fabricated zone). A clean result (even empty) is
 * stored so the node reads `outside-sfha` / a real zone.
 */
async function fetchFemaTiles(
  tiles: string[],
  concurrency: number,
  stats: TileStats,
): Promise<Map<string, FemaQueryLike | null>> {
  return mapConcurrent(tiles, concurrency, async (key) => {
    const c = tileCenter(key);
    stats.femaTilesFetched += 1;
    try {
      const result = await arcgisPointQuery({
        serviceUrl: FEMA_NFHL_FLOOD_ZONES,
        latitude: c.lat,
        longitude: c.lng,
        outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID",
        returnGeometry: false,
        upstreamLabel: "FEMA NFHL",
      });
      return { features: result.features } as FemaQueryLike;
    } catch {
      stats.femaOutages += 1;
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Per-county bake (keyset-paginated; per-page tile fetch + compose + write).
// ---------------------------------------------------------------------------

interface CountyStats {
  fips: string;
  name: string;
  parcelsSeen: number;
  bakeableNodes: number;
  skippedNoNodeId: number;
  skippedNoGeom: number;
  promotedNew: number;
  promotedUpgrade: number;
  keptPriorMonotonic: number;
  envelopeRoadSignal: number;
  envelopePointSignal: number;
  envelopeShapeSignal: number;
  envelopeDeclined: number;
  floodInSfha: number;
  floodZone: number;
  floodOutside: number;
  floodUnavailable: number;
  tiles: TileStats;
}

async function bakeCounty(args: {
  pool: pg.Pool;
  county: CountySource;
  adapterKey: string;
  pageSize: number;
  limit: number | undefined;
  dryRun: boolean;
  roadConcurrency: number;
  femaConcurrency: number;
  roadTimeoutMs: number;
  skipRoads: boolean;
  skipFema: boolean;
  sampleSink: (p: Tier2FacetPayload) => void;
}): Promise<CountyStats> {
  const {
    pool,
    county,
    adapterKey,
    pageSize,
    limit,
    dryRun,
    roadConcurrency,
    femaConcurrency,
    roadTimeoutMs,
    skipRoads,
    skipFema,
  } = args;
  const stats: CountyStats = {
    fips: county.fips,
    name: county.name,
    parcelsSeen: 0,
    bakeableNodes: 0,
    skippedNoNodeId: 0,
    skippedNoGeom: 0,
    promotedNew: 0,
    promotedUpgrade: 0,
    keptPriorMonotonic: 0,
    envelopeRoadSignal: 0,
    envelopePointSignal: 0,
    envelopeShapeSignal: 0,
    envelopeDeclined: 0,
    floodInSfha: 0,
    floodZone: 0,
    floodOutside: 0,
    floodUnavailable: 0,
    tiles: {
      roadTilesFetched: 0,
      roadTilesWithRoads: 0,
      roadFetchFailures: 0,
      femaTilesFetched: 0,
      femaOutages: 0,
    },
  };
  const nowIso = new Date().toISOString();
  let after = -1;

  for (;;) {
    const remaining =
      limit !== undefined ? Math.max(0, limit - stats.parcelsSeen) : pageSize;
    if (remaining === 0) break;
    const pageLimit = Math.min(pageSize, remaining);
    const zoningSelect = county.hasZoning
      ? "zoning_district"
      : "NULL::text AS zoning_district";
    const r = await pool.query<ParcelRow>(
      `SELECT DISTINCT ON (feature_index)
              feature_index, prop_id, situs_address, situs_city, situs_state,
              ${zoningSelect}, geometry
         FROM ${county.table}
        WHERE county_fips = $1
          AND feature_index > $2
        ORDER BY feature_index
        LIMIT $3`,
      [county.fips, after, pageLimit],
    );
    if (r.rows.length === 0) break;

    // ---- PHASE 1: prepare per-node compute inputs + collect tiles. --------
    interface NodePrep {
      placeKey: string;
      nodeId: string;
      row: ParcelRow;
      ring: Ring | null;
      centroid: { lat: number; lng: number };
      roadTile: string | null;
      femaTile: string | null;
    }
    const prepped: NodePrep[] = [];
    const roadTiles = new Set<string>();
    const femaTiles = new Set<string>();

    for (const row of r.rows) {
      after = row.feature_index;
      stats.parcelsSeen += 1;
      const nodeId = parcelNodeId(county.fips, row.prop_id);
      if (!nodeId) {
        stats.skippedNoNodeId += 1;
        continue;
      }
      stats.bakeableNodes += 1;
      const ring = firstRing(row.geometry);
      if (!ring) stats.skippedNoGeom += 1;
      const centroid = ring ? ringCentroid(ring) : { lat: 0, lng: 0 };
      const hasPoint =
        ring != null &&
        Number.isFinite(centroid.lat) &&
        Number.isFinite(centroid.lng) &&
        !(centroid.lat === 0 && centroid.lng === 0);
      const roadTile =
        hasPoint && !skipRoads
          ? tileKey(centroid.lat, centroid.lng, ROAD_TILE_DEG)
          : null;
      const femaTile =
        hasPoint && !skipFema
          ? tileKey(centroid.lat, centroid.lng, FEMA_TILE_DEG)
          : null;
      if (roadTile) roadTiles.add(roadTile);
      if (femaTile) femaTiles.add(femaTile);
      prepped.push({
        placeKey: placeKeyForNode(nodeId),
        nodeId,
        row,
        ring,
        centroid,
        roadTile,
        femaTile,
      });
    }

    // ---- PHASE 2: CACHE-FIRST tile fetch (one per tile, reused). ----------
    const roadCache = skipRoads
      ? new Map<string, RoadCandidate[]>()
      : await fetchRoadTiles(
          [...roadTiles],
          roadConcurrency,
          roadTimeoutMs,
          stats.tiles,
        );
    const femaCache = skipFema
      ? new Map<string, FemaQueryLike | null>()
      : await fetchFemaTiles([...femaTiles], femaConcurrency, stats.tiles);

    // ---- PHASE 3: compose each node from the warm tile cache. -------------
    const computed: {
      placeKey: string;
      payload: Tier2FacetPayload;
      centroid: { lat: number; lng: number };
      prior: Tier2Prior | undefined;
    }[] = [];

    const priors = await readTier2SnapshotsBatch(
      pool,
      adapterKey,
      prepped.map((p) => p.placeKey),
    );

    for (const p of prepped) {
      const roads = p.roadTile ? (roadCache.get(p.roadTile) ?? []) : [];
      const femaResult = p.femaTile
        ? (femaCache.get(p.femaTile) ?? null)
        : null;

      const envelope: Tier2EnvelopeFacet | null = p.ring
        ? computeTier2Envelope({
            ring: p.ring,
            zoningCode: p.row.zoning_district,
            situsCity: p.row.situs_city,
            situsState: p.row.situs_state,
            situsAddress: p.row.situs_address,
            roads,
            refPoint:
              p.centroid.lat === 0 && p.centroid.lng === 0
                ? null
                : { lng: p.centroid.lng, lat: p.centroid.lat },
            roadFetchAttempted: p.roadTile != null,
          })
        : null;

      // FEMA: skipFema (or no usable point) -> unavailable with a clear reason
      // (not a silent absence). A fetched tile that is null -> outage.
      const flood: Tier2FloodFacet = skipFema
        ? buildFloodFacet(null, nowIso, "FEMA fetch skipped (--skip-fema)")
        : p.femaTile == null
          ? buildFloodFacet(null, nowIso, "no usable parcel centroid for FEMA query")
          : buildFloodFacet(
              femaResult,
              nowIso,
              femaResult === null ? "FEMA NFHL point query failed" : undefined,
            );

      // Accounting.
      if (envelope) {
        if (envelope.status === "declined") stats.envelopeDeclined += 1;
        else if (envelope.edgeSignal === "road") stats.envelopeRoadSignal += 1;
        else if (envelope.edgeSignal === "point") stats.envelopePointSignal += 1;
        else stats.envelopeShapeSignal += 1;
      }
      switch (flood.status) {
        case "in-sfha":
          stats.floodInSfha += 1;
          break;
        case "flood-zone":
          stats.floodZone += 1;
          break;
        case "outside-sfha":
          stats.floodOutside += 1;
          break;
        case "unavailable":
          stats.floodUnavailable += 1;
          break;
      }

      const payload: Tier2FacetPayload = {
        facetSchemaVersion: TIER2_FACET_SCHEMA_VERSION,
        tier: 2,
        parcelNodeId: p.nodeId,
        countyFips: county.fips,
        countyName: county.name,
        envelope,
        flood,
        provenance: {
          roadsPending: false,
          roadSource: "osm-overpass",
          floodSource: "fema-nfhl",
          tierNote:
            "Tier 2 (live-dep). Buildable envelope upgraded with OSM " +
            "road-based front-edge labeling; FEMA NFHL flood zone per node. " +
            "Honest absence on any live-dep failure (never a fabricated value).",
        },
        bakedAt: nowIso,
      };
      args.sampleSink(payload);
      computed.push({
        placeKey: p.placeKey,
        payload,
        centroid: p.centroid,
        prior: priors.get(p.placeKey),
      });
    }

    // ---- PHASE 4: monotonic decide + batch write. -------------------------
    const toWrite: BakeWriteItem[] = [];
    const pending = new Map<string, Tier2Prior>();
    for (const c of computed) {
      const priorState: Tier2Prior | null =
        pending.get(c.placeKey) ?? c.prior ?? null;
      const nextState: Tier2Prior = {
        envelope: c.payload.envelope,
        flood: c.payload.flood,
      };
      if (!shouldPromoteTier2(priorState, nextState)) {
        stats.keptPriorMonotonic += 1;
        continue;
      }
      if (priorState) stats.promotedUpgrade += 1;
      else stats.promotedNew += 1;
      pending.set(c.placeKey, nextState);
      toWrite.push({
        placeKey: c.placeKey,
        centroid: c.centroid,
        payload: c.payload,
      });
    }
    // De-dupe to the last write per placeKey (a placeKey shouldn't repeat
    // within a page — DISTINCT ON feature_index — but be safe).
    const lastByKey = new Map<string, BakeWriteItem>();
    for (const it of toWrite) lastByKey.set(it.placeKey, it);
    if (!dryRun) {
      await writeSnapshotsBatch(pool, adapterKey, [...lastByKey.values()]);
    }

    if (r.rows.length < pageLimit) break;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      county: { type: "string" },
      limit: { type: "string" },
      "page-size": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "adapter-key": { type: "string" },
      "road-concurrency": { type: "string" },
      "fema-concurrency": { type: "string" },
      "road-timeout-ms": { type: "string" },
      "skip-roads": { type: "boolean", default: false },
      "skip-fema": { type: "boolean", default: false },
      "sample-count": { type: "string" },
    },
  });

  const fips = values.county?.trim();
  if (!fips) {
    fail(
      "--county=<fips> is required (Tier-2 bake is per-county). " +
        "e.g. --county=48055 (Caldwell). Full-county Tier-2 is tile-batched; " +
        "run bounded (--limit) first to measure the rate.",
    );
  }
  const adapterKey = values["adapter-key"]?.trim() || TIER2_ADAPTER_KEY;
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  // Smaller default page than Tier 1 (2000): a page's tiles are fetched live,
  // so a giant page front-loads a lot of Overpass/FEMA calls before any write.
  const pageSize =
    values["page-size"] !== undefined ? Number(values["page-size"]) : 2000;
  const dryRun = values["dry-run"] ?? false;
  const roadConcurrency =
    values["road-concurrency"] !== undefined
      ? Number(values["road-concurrency"])
      : 2; // Overpass allows ~2 slots; do not exceed without a private mirror.
  const femaConcurrency =
    values["fema-concurrency"] !== undefined
      ? Number(values["fema-concurrency"])
      : 4;
  const roadTimeoutMs =
    values["road-timeout-ms"] !== undefined
      ? Number(values["road-timeout-ms"])
      : 12_000;
  const skipRoads = values["skip-roads"] ?? false;
  const skipFema = values["skip-fema"] ?? false;
  const sampleCount =
    values["sample-count"] !== undefined ? Number(values["sample-count"]) : 3;

  const startedAt = Date.now();
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
    max: 4,
  });

  const samples: Tier2FacetPayload[] = [];
  const sampleSink = (p: Tier2FacetPayload): void => {
    if (samples.length < sampleCount) samples.push(p);
  };

  let stats: CountyStats;
  try {
    const county = await discoverCounty(pool, fips);
    if (!county) {
      fail(`county ${fips} has no parcels in txgio_parcel or _staging`);
    }
    log(
      `${dryRun ? "DRY-RUN " : ""}baking Tier-2 node facets for ` +
        `${county.fips}/${county.name} from ${county.table} ` +
        `(${county.parcelCount} parcels)` +
        (limit !== undefined ? `, limit ${limit}` : "") +
        `, adapter_key=${adapterKey}` +
        (skipRoads ? ", SKIP-ROADS" : "") +
        (skipFema ? ", SKIP-FEMA" : "") +
        `, road-concurrency=${roadConcurrency}, fema-concurrency=${femaConcurrency}`,
    );

    stats = await bakeCounty({
      pool,
      county,
      adapterKey,
      pageSize,
      limit,
      dryRun,
      roadConcurrency,
      femaConcurrency,
      roadTimeoutMs,
      skipRoads,
      skipFema,
      sampleSink,
    });
  } finally {
    await pool.end();
  }

  const seconds = (Date.now() - startedAt) / 1000;
  const rate = seconds > 0 ? stats.bakeableNodes / seconds : 0;
  const pct = (n: number): string =>
    stats.bakeableNodes > 0
      ? `${((n / stats.bakeableNodes) * 100).toFixed(1)}%`
      : "n/a";

  log("---- Tier-2 bake summary ----");
  log(`county:                ${stats.fips}/${stats.name}`);
  log(`mode:                  ${dryRun ? "DRY-RUN (no writes)" : "WRITE"}`);
  log(`adapter_key:           ${adapterKey}`);
  log(`parcels seen:          ${stats.parcelsSeen}`);
  log(`  skipped (no id):     ${stats.skippedNoNodeId}`);
  log(`  skipped (no geom):   ${stats.skippedNoGeom}`);
  log(`bakeable nodes:        ${stats.bakeableNodes}`);
  log(`  promoted (new):      ${stats.promotedNew}`);
  log(`  promoted (upgrade):  ${stats.promotedUpgrade}`);
  log(`  kept prior (mono):   ${stats.keptPriorMonotonic}`);
  log(`envelope edge signal (of bakeable):`);
  log(`  road (HIGH conf):    ${stats.envelopeRoadSignal} (${pct(stats.envelopeRoadSignal)})`);
  log(`  point (med conf):    ${stats.envelopePointSignal} (${pct(stats.envelopePointSignal)})`);
  log(`  shape (low, degraded):${stats.envelopeShapeSignal} (${pct(stats.envelopeShapeSignal)})`);
  log(`  declined:            ${stats.envelopeDeclined} (${pct(stats.envelopeDeclined)})`);
  log(`flood facet (of bakeable):`);
  log(`  in-SFHA:             ${stats.floodInSfha} (${pct(stats.floodInSfha)})`);
  log(`  flood-zone (non-SFHA):${stats.floodZone} (${pct(stats.floodZone)})`);
  log(`  outside-SFHA:        ${stats.floodOutside} (${pct(stats.floodOutside)})`);
  log(`  unavailable (absent):${stats.floodUnavailable} (${pct(stats.floodUnavailable)})`);
  log(`tile cache (the cost control):`);
  log(`  road tiles fetched:  ${stats.tiles.roadTilesFetched} (with roads: ${stats.tiles.roadTilesWithRoads}, failures: ${stats.tiles.roadFetchFailures})`);
  log(`  fema tiles fetched:  ${stats.tiles.femaTilesFetched} (outages: ${stats.tiles.femaOutages})`);
  const nodesPerRoadTile =
    stats.tiles.roadTilesFetched > 0
      ? (stats.bakeableNodes / stats.tiles.roadTilesFetched).toFixed(1)
      : "n/a";
  const nodesPerFemaTile =
    stats.tiles.femaTilesFetched > 0
      ? (stats.bakeableNodes / stats.tiles.femaTilesFetched).toFixed(1)
      : "n/a";
  log(`  amortization:        ${nodesPerRoadTile} nodes/road-tile, ${nodesPerFemaTile} nodes/fema-tile`);
  log(`duration:              ${seconds.toFixed(1)}s`);
  log(`measured rate:         ${rate.toFixed(1)} nodes/sec`);

  if (samples.length) {
    log(`---- sample owner-free Tier-2 payloads (${samples.length}) ----`);
    for (const s of samples) {
      const json = JSON.stringify(s);
      if (/"owner/i.test(json)) {
        fail(`OWNER LEAK in sample payload for ${s.parcelNodeId} — aborting.`);
      }
      console.log(JSON.stringify(s, null, 2));
    }
  }
}

function isDirectRun(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("[node-facet-bake-t2] FATAL:", err);
    process.exit(1);
  });
}

export { bakeCounty, computeTier2Envelope, buildFloodFacet };
