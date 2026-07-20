#!/usr/bin/env node
/**
 * Tier-1 node-facet warm-up bake CLI — parcel-node inspect-card pre-compute.
 *
 * Pre-computes the CHEAP, DETERMINISTIC facets for every Central-TX parcel
 * node and stores them in `place_layer_snapshots` under the adapter key
 * `node-facets:tier1`, keyed by the canonical `parcel_node_id`, so the map's
 * inspect card renders as a PURE READ (zero AI, zero live fetch). This is
 * Tier 1 ONLY — the deterministic facets that need no live external call.
 * Tiers 2-3 (live-dep + expensive: real road-based envelope, FEMA/3DEP,
 * permits, propensity) are separate later dispatches.
 *
 * TIER-1 FACETS baked per node (all deterministic, DB-local compute):
 *   1. Base facts — situs address, APN, land-use code+description (via the
 *      merged `normalizeForJoin` R-fix join to `cad_property`), and acreage
 *      (shoelace on the geometry). OWNER NAME IS EXCLUDED from the payload
 *      (privacy: this is a public, anonymous browse read); the owner column
 *      is NEVER selected.
 *   2. Zoning district — the stored `zoning_district` column, read verbatim.
 *   3. Setbacks + buildable envelope — the codified setback table
 *      (`getSetbackTable` -> `mapDistrict` on the zoning code) inset per edge
 *      by `deriveBuildableEnvelope`, computed WITHOUT roads (the skipRoad /
 *      lot-shape labeling path). This is the SAME deterministic composition
 *      the buildable-envelope route runs with `skipRoad=true`, so a Tier-1
 *      bake and a live skipRoad call produce the same envelope. It is marked
 *      `provisional` + `roadsPending` (low, shape-only confidence); Tier 2
 *      upgrades it with the OSM road-based front-edge labeling.
 *
 * MONOTONIC / verify-before-promote (the Austin-re-warm-downgrade lesson).
 *   A re-bake NEVER downgrades a node. Before writing, the stored snapshot
 *   (if any) is read and SCORED; the freshly-computed payload is scored the
 *   same way; the write proceeds ONLY when the new payload is >= the stored
 *   one (more facets present, ties broken by envelope confidence). A worse
 *   re-computation (lost a facet, or lower confidence) is DISCARDED and the
 *   better prior high-water-mark is kept. See `facetScore` + `bakeNode`.
 *
 * HONEST ABSENCE (structural commitment #1 — never fabricate a facet).
 *   A node that legitimately lacks a facet stores it as absent, never
 *   fabricated: Comal (no CAD roll) bakes with `landUse: null`; a parcel
 *   outside every zoning polygon (null `zoning_district`) bakes with
 *   `zoning: null`; a parcel with no codified setback jurisdiction or an
 *   un-mappable district bakes the envelope with an honest non-ok status.
 *
 * IDEMPOTENT + RESUMABLE. Per-county, keyset-paginated on `feature_index`
 * with DISTINCT ON to collapse the one-row-per-cell duplication (same read
 * shape as the PMTiles bake). Re-running a county re-computes each node and
 * the monotonic guard makes a re-run safe (no double-work harm, no
 * downgrade). `--dry-run` computes + scores + reports WITHOUT writing.
 *
 * Usage (from repo root):
 *   pnpm --filter @artifacts/api-server node-facet-bake-tier1 -- \
 *     --county=48055 [--limit=500] [--dry-run] [--page-size=5000] \
 *     [--adapter-key=node-facets:tier1]   # override for a test key
 *
 *   or directly:
 *   tsx artifacts/api-server/src/nodeFacetBakeTier1Cli.ts --county=48055 --dry-run
 *
 * DATABASE_URL must point at the parcel Postgres (falls back to loading the
 * DEPLOYMENT_DATABASE_URL secret via gcloud, mirroring the PMTiles bake).
 * This is PROD. Tier-1 needs NO egress — all compute is DB-local +
 * deterministic; the CLI never calls OSM / FEMA / 3DEP / any live adapter.
 *
 * Exit-bounded: connect -> per-county paged compute+write -> summary, then
 * exit. Exit 0 on success, 1 on fatal error.
 *
 * NB: imports are the DEPENDENCY-FREE / DB-free helpers only (the same
 * discipline the PMTiles bake follows) — the pure geometry/setback/envelope
 * modules and `@workspace/adapters` (which does NOT import `@workspace/db`).
 * `txgioParcelStore` is deliberately NOT imported: it drags `@workspace/db`,
 * which would throw on a missing DATABASE_URL at module load, and its
 * `toFeature()` stamps `owner` onto the feature — which Tier 1 must exclude.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import { parcelNodeId, normalizeCadPropId } from "./lib/parcelNodeId";
import { normalizeForJoin } from "./lib/joinNormalize";
import { ptadLandUseDescription } from "./lib/ptadLandUse";
import { contentHashForPayload } from "./lib/placeLayerUtils";
import {
  computeTier1Envelope,
  parcelAcreage,
  ringCentroid,
  type Tier1EnvelopeFacet,
  type Ring,
} from "./lib/nodeFacetBakeTier1";

const { Pool } = pg;

export const TIER1_ADAPTER_KEY = "node-facets:tier1";
export const TIER1_FACET_SCHEMA_VERSION = "node-facets-tier1-v1";

// The ten Central-TX counties unified in the parcel fabric (Wave D1/D2).
// Nine carry (or can carry) a CAD land-use roll; Comal (48091) is geometry-
// only (no roll loaded) and bakes honestly land-use-absent.
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

/** Tables read, prod winning over staging for a county (same as PMTiles bake). */
const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

function log(msg: string): void {
  console.log(`[node-facet-bake-t1] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[node-facet-bake-t1] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution — env, else DEPLOYMENT_DATABASE_URL via gcloud
// (identical fallback to parcelsPmtilesBakeCli).
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
// Table + county discovery (prod wins over staging on a collision).
// ---------------------------------------------------------------------------

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const r = await pool.query<{ r: string | null }>(
    "SELECT to_regclass($1) AS r",
    [table],
  );
  return r.rows[0]?.r != null;
}

interface CountySource {
  fips: string;
  name: string;
  table: string;
  parcelCount: number;
  /**
   * Whether the chosen table carries the `zoning_district` column. The prod
   * `txgio_parcel` table has it; the older `txgio_parcel_staging` bulk-load
   * table does NOT (it predates the zoning stamp). A county served from a
   * table without the column bakes zoning-absent HONESTLY (NULL) rather than
   * crashing the SELECT — never a fabricated district.
   */
  hasZoning: boolean;
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
// Land-use join — one query per county, latest coded tax-year row per parcel.
// Keyed by normalizeForJoin(prop_id) (the merged R-prefix fix). Comal (no
// roll) yields an empty map -> every node bakes land-use-absent, honestly.
// ---------------------------------------------------------------------------

interface LandUse {
  landUseCode: string;
  landUseVintage: string;
}

async function fetchCountyLandUse(
  pool: pg.Pool,
  fips: string,
): Promise<Map<string, LandUse>> {
  const out = new Map<string, LandUse>();
  if (!(await tableExists(pool, "cad_property"))) return out;
  const r = await pool.query<{
    prop_id: string;
    property_use_code: string;
    source_vintage: string;
  }>(
    `SELECT DISTINCT ON (prop_id)
            prop_id, property_use_code, source_vintage
       FROM cad_property
      WHERE county_fips = $1
        AND property_use_code IS NOT NULL
      ORDER BY prop_id, tax_year DESC`,
    [fips],
  );
  for (const row of r.rows) {
    out.set(row.prop_id, {
      landUseCode: row.property_use_code,
      landUseVintage: row.source_vintage,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier-1 facet payload assembly (owner-excluded, honest-absence).
// ---------------------------------------------------------------------------

interface BaseFacts {
  apn: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  situsState: string | null;
  landUse: {
    code: string;
    description: string | null;
    source: "cad-roll";
    vintage: string;
  } | null;
  acreage: { value: number; sqft: number; method: "shoelace-wgs84" } | null;
}

export interface Tier1FacetPayload {
  facetSchemaVersion: string;
  tier: 1;
  parcelNodeId: string;
  countyFips: string;
  countyName: string;
  baseFacts: BaseFacts;
  zoning: { district: string } | null;
  envelope: Tier1EnvelopeFacet | null;
  /**
   * Per-facet presence, the load-bearing input to the monotonic scorer. A
   * true means the facet resolved to real content; a false means honest
   * absence (no fabrication). `envelope` counts as present only when it
   * derived a real (or honestly-empty) envelope, not when it declined for a
   * missing table/district.
   */
  facetCoverage: {
    baseFacts: boolean;
    landUse: boolean;
    acreage: boolean;
    zoning: boolean;
    envelope: boolean;
  };
  provenance: {
    parcelSource: "txgio";
    parcelVintage: string | null;
    landUseSource: "cad-roll" | null;
    roadsPending: true;
    tierNote: string;
  };
  bakedAt: string;
}

/** A parcel row as selected for the bake — NOTE: owner_name is NEVER selected. */
interface ParcelRow {
  feature_index: number;
  prop_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  zoning_district: string | null;
  source_vintage: string | null;
  geometry: unknown;
}

/**
 * First outer ring (lng/lat) out of a GeoJSON Polygon | MultiPolygon
 * geometry. Null when the geometry is not a usable polygon.
 */
export function firstRing(geometry: unknown): Ring | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g) return null;
  let ring: unknown = null;
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    ring = g.coordinates[0];
  } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0];
    ring = Array.isArray(first) ? first[0] : null;
  }
  if (!Array.isArray(ring) || ring.length < 4) return null;
  return ring as Ring;
}

/**
 * Build the Tier-1 payload for one parcel row. Pure + owner-free: the owner
 * column is not even a field on `ParcelRow`, so it CANNOT leak into the
 * payload. Every facet is either real content or an honest null.
 */
export function buildTier1Payload(
  row: ParcelRow,
  countyFips: string,
  countyName: string,
  landUse: Map<string, LandUse>,
  nowIso: string,
): Tier1FacetPayload | null {
  const nodeId = parcelNodeId(countyFips, row.prop_id);
  // No node id -> no stable key -> cannot bake this parcel (never fabricate an
  // id). The caller counts it as skipped.
  if (!nodeId) return null;

  const ring = firstRing(row.geometry);

  // --- Base facts ---
  const str = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  let luFacet: BaseFacts["landUse"] = null;
  if (row.prop_id) {
    const lu = landUse.get(normalizeForJoin(row.prop_id));
    if (lu) {
      luFacet = {
        code: lu.landUseCode,
        description: ptadLandUseDescription(lu.landUseCode) ?? null,
        source: "cad-roll",
        vintage: lu.landUseVintage,
      };
    }
  }

  const acreage = ring ? parcelAcreage(ring) : null;

  const baseFacts: BaseFacts = {
    apn: str(row.prop_id),
    situsAddress: str(row.situs_address),
    situsCity: str(row.situs_city),
    situsState: str(row.situs_state),
    landUse: luFacet,
    acreage,
  };

  // --- Zoning (stored column, verbatim; honest null when unstamped) ---
  const zoningDistrict = str(row.zoning_district);
  const zoning = zoningDistrict ? { district: zoningDistrict } : null;

  // --- Setbacks + buildable envelope (skipRoad / shape-only, provisional) ---
  // Deterministic given zoning + geometry; needs the jurisdiction (city/state)
  // for the setback table lookup, taken from the parcel's own situs.
  const envelope: Tier1EnvelopeFacet | null = ring
    ? computeTier1Envelope({
        ring,
        zoningCode: zoningDistrict,
        situsCity: baseFacts.situsCity,
        situsState: baseFacts.situsState,
        situsAddress: baseFacts.situsAddress,
      })
    : null;

  const facetCoverage = {
    baseFacts: baseFacts.apn != null || baseFacts.situsAddress != null,
    landUse: luFacet != null,
    acreage: acreage != null,
    zoning: zoning != null,
    // Envelope counts as a present facet only when it actually derived (ok or
    // honestly-empty), NOT when it declined (no table / no district / no ring).
    envelope: envelope != null && envelope.status !== "declined",
  };

  return {
    facetSchemaVersion: TIER1_FACET_SCHEMA_VERSION,
    tier: 1,
    parcelNodeId: nodeId,
    countyFips,
    countyName,
    baseFacts,
    zoning,
    envelope,
    facetCoverage,
    provenance: {
      parcelSource: "txgio",
      parcelVintage: str(row.source_vintage),
      landUseSource: luFacet ? "cad-roll" : null,
      roadsPending: true,
      tierNote:
        "Tier 1 (deterministic). Buildable envelope computed WITHOUT roads " +
        "(lot-shape front-edge labeling) — provisional, lower confidence; " +
        "Tier 2 upgrades it with road-based labeling.",
    },
    bakedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Monotonic high-water-mark scoring (verify-before-promote).
// ---------------------------------------------------------------------------

/**
 * Score a Tier-1 payload for the monotonic guard. Primary axis: number of
 * facets PRESENT (real content, not honest-absence). Secondary axis (tie-
 * break): the envelope confidence, so a re-bake that keeps every facet but
 * derives a HIGHER-confidence envelope still promotes, and a LOWER-confidence
 * re-derivation does not. Higher score == better == the one to keep.
 *
 * Encoded as a single number: facetCount * 1000 + round(confidence*100). The
 * *1000 makes facet count strictly dominate the sub-point confidence term.
 */
export function facetScore(payload: Tier1FacetPayload): number {
  const c = payload.facetCoverage;
  const facetCount =
    (c.baseFacts ? 1 : 0) +
    (c.landUse ? 1 : 0) +
    (c.acreage ? 1 : 0) +
    (c.zoning ? 1 : 0) +
    (c.envelope ? 1 : 0);
  const conf = payload.envelope?.confidence ?? 0;
  return facetCount * 1000 + Math.round(conf * 100);
}

/**
 * Decide whether `next` may overwrite `prior`. The freshly computed payload
 * promotes only when it is at least as good as the stored high-water-mark. A
 * strictly-worse re-computation (fewer facets, or lower envelope confidence
 * at equal facet count) is rejected — the better prior is kept. Equal scores
 * promote (a same-quality refresh updates vintage/bakedAt harmlessly).
 */
export function shouldPromote(
  prior: Tier1FacetPayload | null,
  next: Tier1FacetPayload,
): boolean {
  if (!prior) return true;
  return facetScore(next) >= facetScore(prior);
}

// ---------------------------------------------------------------------------
// Snapshot read/write (raw pg — DB-free at module load, prod-safe lazily).
// ---------------------------------------------------------------------------

function placeKeyForNode(nodeId: string): string {
  return `node:${nodeId}`;
}

async function readSnapshot(
  pool: pg.Pool,
  adapterKey: string,
  placeKey: string,
): Promise<Tier1FacetPayload | null> {
  const r = await pool.query<{ payload_json: unknown }>(
    `SELECT payload_json
       FROM place_layer_snapshots
      WHERE adapter_key = $1 AND place_key = $2
      LIMIT 1`,
    [adapterKey, placeKey],
  );
  const raw = r.rows[0]?.payload_json;
  if (!raw || typeof raw !== "object") return null;
  // Only treat it as a comparable prior if it carries our facetCoverage shape.
  const p = raw as Partial<Tier1FacetPayload>;
  if (!p.facetCoverage || !p.parcelNodeId) return null;
  return raw as Tier1FacetPayload;
}

async function writeSnapshot(
  pool: pg.Pool,
  adapterKey: string,
  placeKey: string,
  centroid: { lat: number; lng: number },
  payload: Tier1FacetPayload,
): Promise<void> {
  const contentHash = contentHashForPayload(
    payload as unknown as Record<string, unknown>,
  );
  const latRounded = centroid.lat.toFixed(5);
  const lngRounded = centroid.lng.toFixed(5);
  const now = new Date();
  await pool.query(
    `INSERT INTO place_layer_snapshots
       (place_key, adapter_key, lat_rounded, lng_rounded, ll_uuid,
        payload_json, content_hash, snapshot_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $7, $7)
     ON CONFLICT (adapter_key, place_key) DO UPDATE SET
       lat_rounded = EXCLUDED.lat_rounded,
       lng_rounded = EXCLUDED.lng_rounded,
       payload_json = EXCLUDED.payload_json,
       content_hash = EXCLUDED.content_hash,
       snapshot_at = EXCLUDED.snapshot_at,
       updated_at = EXCLUDED.updated_at`,
    [
      placeKey,
      adapterKey,
      latRounded,
      lngRounded,
      JSON.stringify(payload),
      contentHash,
      now,
    ],
  );
}

// ---------------------------------------------------------------------------
// Per-county bake (keyset-paginated on feature_index, DISTINCT ON dedupe).
// ---------------------------------------------------------------------------

interface CountyStats {
  fips: string;
  name: string;
  parcelsSeen: number;
  baked: number;
  skippedNoNodeId: number;
  skippedNoGeom: number;
  promotedNew: number;
  promotedUpgrade: number;
  keptPriorMonotonic: number;
  facetHits: {
    landUse: number;
    acreage: number;
    zoning: number;
    envelopeDerived: number;
    envelopeOk: number;
  };
}

async function bakeCounty(args: {
  pool: pg.Pool;
  county: CountySource;
  landUse: Map<string, LandUse>;
  adapterKey: string;
  pageSize: number;
  limit: number | undefined;
  dryRun: boolean;
  sampleSink: (p: Tier1FacetPayload) => void;
}): Promise<CountyStats> {
  const { pool, county, landUse, adapterKey, pageSize, limit, dryRun } = args;
  const stats: CountyStats = {
    fips: county.fips,
    name: county.name,
    parcelsSeen: 0,
    baked: 0,
    skippedNoNodeId: 0,
    skippedNoGeom: 0,
    promotedNew: 0,
    promotedUpgrade: 0,
    keptPriorMonotonic: 0,
    facetHits: {
      landUse: 0,
      acreage: 0,
      zoning: 0,
      envelopeDerived: 0,
      envelopeOk: 0,
    },
  };
  const nowIso = new Date().toISOString();
  let after = -1;

  for (;;) {
    const remaining =
      limit !== undefined ? Math.max(0, limit - stats.parcelsSeen) : pageSize;
    if (remaining === 0) break;
    const pageLimit = Math.min(pageSize, remaining);
    // OWNER IS NOT SELECTED — the payload cannot contain owner_name.
    // `zoning_district` is selected only when the table has it (prod does;
    // the staging table does not) — else NULL, honest zoning-absence.
    const zoningSelect = county.hasZoning
      ? "zoning_district"
      : "NULL::text AS zoning_district";
    const r = await pool.query<ParcelRow>(
      `SELECT DISTINCT ON (feature_index)
              feature_index, prop_id, situs_address, situs_city, situs_state,
              ${zoningSelect}, source_vintage, geometry
         FROM ${county.table}
        WHERE county_fips = $1
          AND feature_index > $2
        ORDER BY feature_index
        LIMIT $3`,
      [county.fips, after, pageLimit],
    );
    if (r.rows.length === 0) break;

    for (const row of r.rows) {
      after = row.feature_index;
      stats.parcelsSeen += 1;

      const payload = buildTier1Payload(
        row,
        county.fips,
        county.name,
        landUse,
        nowIso,
      );
      if (!payload) {
        stats.skippedNoNodeId += 1;
        continue;
      }
      const ring = firstRing(row.geometry);
      if (!ring) {
        stats.skippedNoGeom += 1;
      }

      // Facet-hit accounting (over PARCELS with a node id, i.e. bakeable).
      if (payload.facetCoverage.landUse) stats.facetHits.landUse += 1;
      if (payload.facetCoverage.acreage) stats.facetHits.acreage += 1;
      if (payload.facetCoverage.zoning) stats.facetHits.zoning += 1;
      if (payload.facetCoverage.envelope) stats.facetHits.envelopeDerived += 1;
      if (payload.envelope?.status === "ok") stats.facetHits.envelopeOk += 1;

      args.sampleSink(payload);

      const placeKey = placeKeyForNode(payload.parcelNodeId);

      // --- Monotonic guard: read prior, score, promote only if >= ---
      const prior = await readSnapshot(pool, adapterKey, placeKey);
      if (!shouldPromote(prior, payload)) {
        stats.keptPriorMonotonic += 1;
        continue;
      }

      if (!dryRun) {
        const centroid = ring
          ? ringCentroid(ring)
          : { lat: 0, lng: 0 };
        await writeSnapshot(pool, adapterKey, placeKey, centroid, payload);
      }
      stats.baked += 1;
      if (prior) stats.promotedUpgrade += 1;
      else stats.promotedNew += 1;
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
      "sample-count": { type: "string" },
    },
  });

  const fips = values.county?.trim();
  if (!fips) {
    fail(
      "--county=<fips> is required (Tier-1 bake is per-county). " +
        "e.g. --county=48055 (Caldwell). Full-fabric runs are per-county, " +
        "one at a time, on the planner's approval.",
    );
  }
  const adapterKey = values["adapter-key"]?.trim() || TIER1_ADAPTER_KEY;
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const pageSize =
    values["page-size"] !== undefined ? Number(values["page-size"]) : 5000;
  const dryRun = values["dry-run"] ?? false;
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

  const samples: Tier1FacetPayload[] = [];
  const sampleSink = (p: Tier1FacetPayload): void => {
    if (samples.length < sampleCount) samples.push(p);
  };

  let stats: CountyStats;
  try {
    const county = await discoverCounty(pool, fips);
    if (!county) {
      fail(`county ${fips} has no parcels in txgio_parcel or _staging`);
    }
    log(
      `${dryRun ? "DRY-RUN " : ""}baking Tier-1 node facets for ` +
        `${county.fips}/${county.name} from ${county.table} ` +
        `(${county.parcelCount} parcels)` +
        (limit !== undefined ? `, limit ${limit}` : "") +
        `, adapter_key=${adapterKey}`,
    );
    const landUse = await fetchCountyLandUse(pool, county.fips);
    log(`CAD land-use rows for ${county.name}: ${landUse.size}`);

    stats = await bakeCounty({
      pool,
      county,
      landUse,
      adapterKey,
      pageSize,
      limit,
      dryRun,
      sampleSink,
    });
  } finally {
    await pool.end();
  }

  // ---- summary ----
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const bakeable = stats.parcelsSeen - stats.skippedNoNodeId;
  const pct = (n: number): string =>
    bakeable > 0 ? `${((n / bakeable) * 100).toFixed(1)}%` : "n/a";

  log("---- Tier-1 bake summary ----");
  log(`county:              ${stats.fips}/${stats.name}`);
  log(`mode:                ${dryRun ? "DRY-RUN (no writes)" : "WRITE"}`);
  log(`adapter_key:         ${adapterKey}`);
  log(`parcels seen:        ${stats.parcelsSeen}`);
  log(`  skipped (no id):   ${stats.skippedNoNodeId}`);
  log(`  skipped (no geom): ${stats.skippedNoGeom} (baked id-only, envelope/acreage absent)`);
  log(`bakeable nodes:      ${bakeable}`);
  log(`  promoted (new):    ${stats.promotedNew}`);
  log(`  promoted (upgrade):${stats.promotedUpgrade}`);
  log(`  kept prior (mono): ${stats.keptPriorMonotonic}`);
  log(`facet coverage (of bakeable):`);
  log(`  land-use:          ${stats.facetHits.landUse} (${pct(stats.facetHits.landUse)})`);
  log(`  acreage:           ${stats.facetHits.acreage} (${pct(stats.facetHits.acreage)})`);
  log(`  zoning:            ${stats.facetHits.zoning} (${pct(stats.facetHits.zoning)})`);
  log(`  envelope derived:  ${stats.facetHits.envelopeDerived} (${pct(stats.facetHits.envelopeDerived)})`);
  log(`  envelope ok:       ${stats.facetHits.envelopeOk} (${pct(stats.facetHits.envelopeOk)})`);
  log(`duration:            ${seconds}s`);

  if (samples.length) {
    log(`---- sample owner-free payloads (${samples.length}) ----`);
    for (const s of samples) {
      // Guard: assert no owner key anywhere in the serialized payload.
      const json = JSON.stringify(s);
      if (/"owner/i.test(json)) {
        fail(
          `OWNER LEAK in sample payload for ${s.parcelNodeId} — aborting ` +
            `(owner must never be baked).`,
        );
      }
      console.log(JSON.stringify(s, null, 2));
    }
  }
}

/**
 * Entrypoint guard: only run `main()` when this file is executed directly
 * (tsx / node), NOT when a test imports its pure exports (buildTier1Payload,
 * facetScore, shouldPromote, firstRing). Without this, importing the module
 * in the unit test would kick off the DB-connecting CLI.
 */
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
    console.error("[node-facet-bake-t1] FATAL:", err);
    process.exit(1);
  });
}
