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
 *      `landUseJoinKey` join to `cad_property`; per-county gated, see below),
 *      and acreage
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
 *   fabricated: Comal (no CAD roll) bakes with `landUse: null`; Williamson
 *   (48491) and Hays (48209) are GATED OFF via `landUseJoinKey` because their
 *   TxGIO prop_ids do NOT correspond to their CAD roll (a numeric collision
 *   that stamped an unrelated property's land-use; owner-match ~0%), so they
 *   also bake `landUse: null` until an external account crosswalk exists; a
 *   parcel outside every zoning polygon (null `zoning_district`) bakes with
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
import {
  landUseJoinKey,
  addressJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
} from "./lib/joinNormalize";
import {
  loadLedgerBlockedFips,
  resolveAddressLandUse,
  type AddressLandUseEntry,
} from "./lib/joinIntegrityGate";
import { ptadLandUseDescription } from "./lib/ptadLandUse";
import { contentHashForPayload } from "./lib/placeLayerUtils";
import {
  computeTier1Envelope,
  parcelAcreage,
  ringCentroid,
  type Tier1EnvelopeFacet,
  type Ring,
} from "./lib/nodeFacetBakeTier1";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants";
import { soleZoningJurisdictionKey } from "@workspace/cad-ingest/zoning-layers";

const { Pool } = pg;

// Re-exported from the side-effect-free constants module so the server boot
// graph can pull the adapter key WITHOUT importing this bake CLI (whose
// entrypoint guard misfires in the prod bundle and crashes boot). The CLI's
// own uses below are unchanged.
export { TIER1_ADAPTER_KEY };
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
// Looked up via landUseJoinKey(countyFips, prop_id), which normalizes the key
// AND enforces the per-county data-integrity gate (Williamson 48491 / Hays
// 48209 return null -> land-use-absent). Comal (no roll) yields an empty map
// -> every node bakes land-use-absent, honestly.
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
// SITUS-ADDRESS land-use lookup — the RECOVERY source for prop_id-gate-blocked
// counties (Williamson/Hays). Keyed by normalized situs address, DISTINCT ON
// (normalized address) latest coded tax year. Carries the CAD owner_name so the
// per-match owner gate (`resolveAddressLandUse`) can verify each match; the
// owner is used ONLY for gating and never enters the baked payload. READ-ONLY.
// ---------------------------------------------------------------------------

async function fetchCountyLandUseByAddress(
  pool: pg.Pool,
  fips: string,
): Promise<Map<string, AddressLandUseEntry>> {
  const out = new Map<string, AddressLandUseEntry>();
  if (!(await tableExists(pool, "cad_property"))) return out;
  // `normalizeSitusAddress` in SQL: upper + strip non-alphanumeric. Matches the
  // TS `normalizeSitusAddress` the parcel side keys on.
  const r = await pool.query<{
    naddr: string;
    property_use_code: string;
    source_vintage: string;
    owner_name: string | null;
  }>(
    `SELECT DISTINCT ON (upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g')))
            upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g')) AS naddr,
            property_use_code, source_vintage, owner_name
       FROM cad_property
      WHERE county_fips = $1
        AND property_use_code IS NOT NULL
        AND situs_address IS NOT NULL
        AND situs_address <> ''
      ORDER BY upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g')),
               tax_year DESC`,
    [fips],
  );
  for (const row of r.rows) {
    if (!row.naddr) continue;
    out.set(row.naddr, {
      code: row.property_use_code,
      vintage: row.source_vintage,
      owner: row.owner_name,
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
    /**
     * How the land-use was joined. `cad-roll` is the normal prop_id join;
     * `cad-roll-address-join` is the situs-address RECOVERY join used for
     * prop_id-gate-blocked counties (Williamson/Hays), where each accepted
     * match ALSO passed the per-match owner gate. The distinct value lets the
     * card/ledger show HOW the land-use was verified.
     */
    source: LandUseSource;
    vintage: string;
  } | null;
  acreage: { value: number; sqft: number; method: "shoelace-wgs84" } | null;
}

/** The provenance of a recovered land-use — prop_id join vs address recovery. */
export type LandUseSource = "cad-roll" | "cad-roll-address-join";

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
    landUseSource: LandUseSource | null;
    /**
     * True when this node's land-use was recovered via the situs-ADDRESS join
     * (a prop_id-gate-blocked county) rather than the normal prop_id join, and
     * the match passed the per-match owner gate. Distinguishes an address-join
     * land-use from a prop_id-join one at a glance (the ledger/card verification
     * story). False for a normal prop_id-join land-use or an absent one.
     */
    landUseAddressRecovered: boolean;
    roadsPending: true;
    tierNote: string;
    /**
     * True when this county's land-use join is BLOCKED by the owner-match
     * integrity gate (ledger `block` verdict / seed). The load-bearing signal
     * for the monotonic INTEGRITY OVERRIDE: a gate-blocked re-bake must be
     * allowed to strip a previously-promoted (now-known-fabricated) land-use
     * even though dropping the facet lowers the monotonic score. See
     * `shouldPromote`.
     */
    landUseGateBlocked: boolean;
  };
  bakedAt: string;
}

/**
 * A parcel row as selected for the bake.
 *
 * OWNER-NAME HANDLING. `owner_name` (`txgioOwnerForGate`) is selected ONLY for
 * counties whose land-use is recovered via the situs-address join, where the
 * per-match owner gate needs the TxGIO owner to compare against the CAD owner.
 * It is NEVER copied into the baked payload — `buildTier1Payload` uses it only
 * inside `resolveAddressLandUse` and discards it. For every other county it is
 * null (not even selected). The end-to-end owner-leak guard in `main()` still
 * asserts no `owner` key appears in any serialized payload, so this gating
 * usage cannot regress the privacy invariant.
 */
interface ParcelRow {
  feature_index: number;
  prop_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  zoning_district: string | null;
  source_vintage: string | null;
  geometry: unknown;
  /** TxGIO owner — for the address-join per-match gate ONLY; never persisted. */
  txgioOwnerForGate?: string | null;
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
 * The EFFECTIVE land-use block set the bake acts on: the ledger's computed
 * `block` verdicts UNION the known-fabricated bootstrap seed
 * (`LANDUSE_JOIN_DISABLED_FIPS_SEED`). The seed is a PERMANENT FLOOR — a
 * county in the seed is blocked even if the ledger scores it something other
 * than `block` (e.g. Williamson 48491 scores `insufficient-sample` after the
 * R-strip removal drops its real pairs to ~0, so it is NOT a ledger `block`,
 * yet it is a known fabrication that must never re-acquire a land-use). The
 * ledger ADDS to the seed; it never replaces it.
 *
 * This union is what drives BOTH the honest-absence join (via `landUseJoinKey`)
 * AND `provenance.landUseGateBlocked` (which arms the fabrication-correction
 * override). Passing the raw ledger set instead of this union was the live bug:
 * a seed-blocked-but-ledger-insufficient county (Williamson) kept its fabricated
 * prior because `landUseGateBlocked` stayed false and the override never fired.
 */
export function effectiveBlockedFips(
  ledgerBlocked: ReadonlySet<string>,
): Set<string> {
  return new Set<string>([...ledgerBlocked, ...LANDUSE_JOIN_DISABLED_FIPS_SEED]);
}

/**
 * Build the Tier-1 payload for one parcel row. Pure. The owner name (when
 * supplied on `row.txgioOwnerForGate` for the address-recovery gate) is used
 * ONLY to gate an address match and is NEVER copied into the payload, so the
 * output stays owner-free (the `main()` owner-leak guard still asserts this).
 * Every facet is either real content or an honest null.
 *
 * LAND-USE (two join paths, both owner-gated):
 *   - NON-blocked county: the normal prop_id join (`landUseJoinKey`).
 *   - BLOCKED county (prop_id join is a proven collision): the prop_id join
 *     returns null, and instead the SITUS-ADDRESS recovery join fires — but
 *     only PER-MATCH owner-verified. `resolveAddressLandUse` promotes the
 *     address-matched code ONLY when the TxGIO owner and the CAD owner agree; a
 *     match whose owners disagree (or where an owner is blank) yields honest
 *     null, never the mismatched code. A recovered land-use carries
 *     `source: "cad-roll-address-join"`.
 */
export function buildTier1Payload(
  row: ParcelRow,
  countyFips: string,
  countyName: string,
  landUse: Map<string, LandUse>,
  nowIso: string,
  blockedFips?: ReadonlySet<string>,
  addressLandUse?: ReadonlyMap<string, AddressLandUseEntry>,
): Tier1FacetPayload | null {
  const nodeId = parcelNodeId(countyFips, row.prop_id);
  // No node id -> no stable key -> cannot bake this parcel (never fabricate an
  // id). The caller counts it as skipped.
  if (!nodeId) return null;

  const ring = firstRing(row.geometry);

  // Is this county's land-use join gate-blocked? Drives the honest-absence of
  // the prop_id join, the ADDRESS-RECOVERY path, AND the monotonic integrity
  // override that strips a prior fabricated value. `blockedFips` is the
  // ledger-driven set (gate `block` verdicts); omitted -> the gate-output seed.
  const effectiveBlocked = blockedFips ?? LANDUSE_JOIN_DISABLED_FIPS_SEED;
  const landUseGateBlocked = effectiveBlocked.has(countyFips);

  // --- Base facts ---
  const str = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  let luFacet: BaseFacts["landUse"] = null;
  let landUseAddressRecovered = false;
  if (row.prop_id) {
    // landUseJoinKey enforces the per-county data-integrity gate: it returns
    // null for BLOCKED counties (ledger `block` verdict; seed fallback), so
    // those nodes get NO prop_id-join land-use (honest absence) instead of a
    // fabricated numeric-collision match.
    const joinKey = landUseJoinKey(countyFips, row.prop_id, blockedFips);
    const lu = joinKey != null ? landUse.get(joinKey) : undefined;
    if (lu) {
      luFacet = {
        code: lu.landUseCode,
        description: ptadLandUseDescription(lu.landUseCode) ?? null,
        source: "cad-roll",
        vintage: lu.landUseVintage,
      };
    }
  }

  // --- SITUS-ADDRESS RECOVERY (blocked counties only, per-match owner-gated) ---
  // When the prop_id join is gate-blocked (luFacet still null) AND an address
  // lookup was supplied, attempt the recovery join. `addressJoinKey` returns
  // null for non-blocked counties (recovery is scoped to blocked counties), and
  // `resolveAddressLandUse` promotes the matched code ONLY when the TxGIO owner
  // and the CAD owner AGREE — a disagreeing (or owner-blank) match is honest
  // null. So no un-gated address join promotes.
  if (luFacet == null && addressLandUse) {
    const addrKey = addressJoinKey(countyFips, row.situs_address, blockedFips);
    const hit = resolveAddressLandUse(
      addrKey,
      row.txgioOwnerForGate,
      addressLandUse,
    );
    if (hit) {
      luFacet = {
        code: hit.code,
        description: ptadLandUseDescription(hit.code) ?? null,
        source: "cad-roll-address-join",
        vintage: hit.vintage,
      };
      landUseAddressRecovered = true;
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
  // Deterministic given zoning + geometry. Jurisdiction for the setback table
  // prefers situs city/address; when situs is blank (Travis TxGIO) and this
  // county has exactly one registered zoning layer, fall back to that city
  // key only for parcels that already carry a zoning stamp.
  const envelope: Tier1EnvelopeFacet | null = ring
    ? computeTier1Envelope({
        ring,
        zoningCode: zoningDistrict,
        situsCity: baseFacts.situsCity,
        situsState: baseFacts.situsState,
        situsAddress: baseFacts.situsAddress,
        zoningJurisdictionFallback: soleZoningJurisdictionKey(countyFips),
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
      landUseSource: luFacet ? luFacet.source : null,
      landUseAddressRecovered,
      roadsPending: true,
      tierNote:
        "Tier 1 (deterministic). Buildable envelope computed WITHOUT roads " +
        "(lot-shape front-edge labeling) — provisional, lower confidence; " +
        "Tier 2 upgrades it with road-based labeling.",
      landUseGateBlocked,
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
 * Does `prior` carry a land-use value that `next` (a gate-blocked re-bake)
 * removes? True exactly when the stored snapshot has a non-null
 * `baseFacts.landUse` (a promoted, now-known-FABRICATED code) and the fresh
 * payload has none. This is the precise, narrow shape of a
 * fabrication-correction: a blocked county whose prior snapshot still carries
 * the collision-stamped land-use.
 */
function isGateBlockedLandUseCorrection(
  prior: Tier1FacetPayload,
  next: Tier1FacetPayload,
): boolean {
  return (
    next.provenance.landUseGateBlocked === true &&
    next.baseFacts.landUse == null &&
    prior.baseFacts.landUse != null
  );
}

/**
 * Decide whether `next` may overwrite `prior`.
 *
 * Normal path (monotonic high-water-mark): the freshly computed payload
 * promotes only when it is at least as good as the stored high-water-mark. A
 * strictly-worse re-computation (fewer facets, or lower envelope confidence at
 * equal facet count) is rejected — the better prior is kept. Equal scores
 * promote (a same-quality refresh updates vintage/bakedAt harmlessly).
 *
 * INTEGRITY OVERRIDE (the fabrication-correction escape hatch). The monotonic
 * guard would otherwise KEEP a fabricated snapshot forever: a Williamson node
 * whose prior payload carries a collision-stamped `baseFacts.landUse` scores
 * HIGHER than the honest re-bake that drops it, so `facetScore(next) <
 * facetScore(prior)` and the fabrication survives every re-bake. When the fresh
 * payload is a GATE-BLOCKED land-use correction (the county's owner-match
 * verdict is `block` AND the re-bake removes a land-use the prior still
 * carries), promotion is FORCED so the fabricated value is actually stripped.
 *
 * This override is scoped as tightly as possible and is NOT a general downgrade
 * bypass: it fires only when (a) the county is gate-blocked, and (b) the sole
 * effect is removing a land-use the prior had. Any other downgrade (an envelope
 * that lost confidence, a zoning that went null, a non-blocked county) still
 * takes the monotonic path and is rejected.
 */
export function shouldPromote(
  prior: Tier1FacetPayload | null,
  next: Tier1FacetPayload,
): boolean {
  if (!prior) return true;
  // Fabrication-correction: force the strip of a gate-blocked county's
  // previously-promoted (fabricated) land-use, even though it lowers the score.
  if (isGateBlockedLandUseCorrection(prior, next)) return true;
  return facetScore(next) >= facetScore(prior);
}

// ---------------------------------------------------------------------------
// Snapshot read/write (raw pg — DB-free at module load, prod-safe lazily).
// ---------------------------------------------------------------------------

function placeKeyForNode(nodeId: string): string {
  return `node:${nodeId}`;
}

export async function readSnapshot(
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

export async function writeSnapshot(
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
// Batched snapshot read/write (per-page, replaces the per-node round-trips).
//
// The per-node `readSnapshot`/`writeSnapshot` above are retained for the unit
// tests and any single-node caller; the page loop drives these batched forms
// so a 5000-node page costs ONE read round-trip + a small number of write
// round-trips instead of 10000 round-trips.
// ---------------------------------------------------------------------------

/** One row queued for the page's batched upsert. */
export interface BakeWriteItem {
  placeKey: string;
  centroid: { lat: number; lng: number };
  payload: Tier1FacetPayload;
}

/**
 * Batch-read priors for every placeKey in a page with ONE query, returning a
 * Map(placeKey -> priorPayload). Only entries carrying our comparable
 * `facetCoverage`+`parcelNodeId` shape are returned (same acceptance filter as
 * the per-node `readSnapshot`), so a malformed/foreign snapshot is treated as
 * "no comparable prior" — identical to the per-node path. Absent keys are
 * simply not in the map (the caller reads that as prior=null).
 */
export async function readSnapshotsBatch(
  pool: pg.Pool,
  adapterKey: string,
  placeKeys: string[],
): Promise<Map<string, Tier1FacetPayload>> {
  const out = new Map<string, Tier1FacetPayload>();
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
    const p = raw as Partial<Tier1FacetPayload>;
    if (!p.facetCoverage || !p.parcelNodeId) continue;
    out.set(row.place_key, raw as Tier1FacetPayload);
  }
  return out;
}

/**
 * Bound-parameter ceiling for a single pg statement. Postgres caps a query at
 * 65535 bound parameters. The batched upsert below uses a FIXED 7 params
 * regardless of row count (adapter_key + now + five per-row arrays), so it can
 * never approach the ceiling on param count alone; the chunk cap here bounds
 * the array sizes / statement memory and mirrors the zoning-stamp batch's
 * 5000-per-chunk discipline. The unnest form means paramsPerRow == 0 (all row
 * data rides inside array literals), so 5000 rows == 7 params, well under 60k.
 */
export const BATCH_WRITE_CHUNK = 5000;

/** Split an array into fixed-size chunks (last chunk may be short). */
export function chunkItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Upsert a page's promoted nodes in ONE round-trip per chunk, using unnest
 * arrays so the parameter count is constant (7) no matter how many rows. The
 * conflict target `(adapter_key, place_key)`, the written columns, the
 * content_hash, the coord columns, and the ll_uuid=NULL / owner-exclusion are
 * BYTE-FOR-BYTE the same as the per-node `writeSnapshot` — only the row count
 * per statement changes. Chunked at BATCH_WRITE_CHUNK for array-size safety.
 */
export async function writeSnapshotsBatch(
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
        contentHashForPayload(
          it.payload as unknown as Record<string, unknown>,
        ),
      );
    }
    // 7 bound params total (2 scalars + 5 arrays), independent of chunk size.
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
// Page-level promotion decision (pure) — the batched analogue of the per-node
// read-decide loop, factored out so the counts are unit-testable without a DB.
// ---------------------------------------------------------------------------

export interface ComputedNode {
  placeKey: string;
  payload: Tier1FacetPayload;
  centroid: { lat: number; lng: number };
}

export interface PagePromotionResult {
  /** Nodes to upsert, de-duped to the LAST promoted payload per placeKey. */
  toWrite: BakeWriteItem[];
  promotedNew: number;
  promotedUpgrade: number;
  keptPriorMonotonic: number;
  /**
   * Promotions that STRIPPED a prior fabricated land-use via the gate-blocked
   * integrity override (a subset of `promotedUpgrade`). The load-bearing count
   * for verifying a blocked county's re-bake actually corrected fabrications
   * rather than being kept by the monotonic guard.
   */
  fabricationCorrected: number;
}

/**
 * Decide, for one page of computed nodes, which promote and which are kept on
 * their prior high-water-mark — using the UNCHANGED `shouldPromote`. This is a
 * pure re-expression of the per-node loop's decide step:
 *
 *  - `priors` is the batch-read map (placeKey -> stored prior, or absent).
 *  - A placeKey repeating within the page uses the running best-so-far as its
 *    baseline (mirrors the per-node loop reading its own just-written row), so
 *    a same-or-better repeat promotes (counted upgrade) and a worse repeat is
 *    kept — identical to the sequential per-node counts.
 *  - `toWrite` is de-duped to the LAST promoted payload per key so the batched
 *    upsert lands the same final row the per-node loop's last write would.
 *
 * shouldPromote and its inputs are untouched: the per-node decision for any
 * given (prior, payload) is byte-for-byte the same here.
 */
export function decidePagePromotions(
  computed: ComputedNode[],
  priors: Map<string, Tier1FacetPayload>,
): PagePromotionResult {
  const pending = new Map<string, Tier1FacetPayload>();
  const writeIndex = new Map<string, number>();
  const toWrite: BakeWriteItem[] = [];
  let promotedNew = 0;
  let promotedUpgrade = 0;
  let keptPriorMonotonic = 0;
  let fabricationCorrected = 0;

  for (const c of computed) {
    const prior = pending.get(c.placeKey) ?? priors.get(c.placeKey) ?? null;
    if (!shouldPromote(prior, c.payload)) {
      keptPriorMonotonic += 1;
      continue;
    }
    if (prior) {
      promotedUpgrade += 1;
      if (isGateBlockedLandUseCorrection(prior, c.payload)) {
        fabricationCorrected += 1;
      }
    } else {
      promotedNew += 1;
    }
    pending.set(c.placeKey, c.payload);
    const item: BakeWriteItem = {
      placeKey: c.placeKey,
      centroid: c.centroid,
      payload: c.payload,
    };
    const existing = writeIndex.get(c.placeKey);
    if (existing === undefined) {
      writeIndex.set(c.placeKey, toWrite.length);
      toWrite.push(item);
    } else {
      toWrite[existing] = item;
    }
  }

  return {
    toWrite,
    promotedNew,
    promotedUpgrade,
    keptPriorMonotonic,
    fabricationCorrected,
  };
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
  fabricationCorrected: number;
  facetHits: {
    landUse: number;
    /** Land-use hits recovered specifically via the situs-address join. */
    landUseAddressRecovered: number;
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
  addressLandUse: ReadonlyMap<string, AddressLandUseEntry>;
  adapterKey: string;
  pageSize: number;
  limit: number | undefined;
  dryRun: boolean;
  blockedFips: ReadonlySet<string>;
  sampleSink: (p: Tier1FacetPayload) => void;
}): Promise<CountyStats> {
  const { pool, county, landUse, addressLandUse, adapterKey, pageSize, limit, dryRun } =
    args;
  const { blockedFips } = args;
  // The address-recovery join needs the TxGIO owner to gate each match. Select
  // it ONLY for a blocked county (the only counties that run the recovery);
  // never for a normal county, and never into the payload.
  const needsOwnerForGate = blockedFips.has(county.fips);
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
    fabricationCorrected: 0,
    facetHits: {
      landUse: 0,
      landUseAddressRecovered: 0,
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
    // OWNER: selected as `txgio_owner_for_gate` ONLY for a blocked county, and
    // ONLY to gate the address-recovery join per match. It is NEVER copied into
    // the payload (the main() owner-leak guard asserts this). For a non-blocked
    // county it is not even selected (NULL). `zoning_district` is selected only
    // when the table has it (prod does; staging does not) — else NULL, honest
    // zoning-absence.
    const zoningSelect = county.hasZoning
      ? "zoning_district"
      : "NULL::text AS zoning_district";
    const ownerSelect = needsOwnerForGate
      ? "owner_name AS txgio_owner_for_gate"
      : "NULL::text AS txgio_owner_for_gate";
    const r = await pool.query<ParcelRow & { txgio_owner_for_gate: string | null }>(
      `SELECT DISTINCT ON (feature_index)
              feature_index, prop_id, situs_address, situs_city, situs_state,
              ${zoningSelect}, ${ownerSelect}, source_vintage, geometry
         FROM ${county.table}
        WHERE county_fips = $1
          AND feature_index > $2
        ORDER BY feature_index
        LIMIT $3`,
      [county.fips, after, pageLimit],
    );
    if (r.rows.length === 0) break;

    // ---- PHASE 1 (COMPUTE) ----------------------------------------------
    // Iterate the page's rows exactly as the per-node loop did: advance the
    // keyset cursor, count parcelsSeen, skip no-nodeId / no-geom, do the
    // facet-hit accounting and sampleSink, and collect the bakeable nodes for
    // the batched prior-read + write. NONE of the accounting here differs from
    // the per-node version — it just no longer interleaves a DB round-trip.
    const computed: ComputedNode[] = [];

    for (const row of r.rows) {
      after = row.feature_index;
      stats.parcelsSeen += 1;

      // Carry the gate-only owner onto the row for the address-recovery match.
      // Not persisted — buildTier1Payload uses it only inside the owner gate.
      row.txgioOwnerForGate =
        (row as ParcelRow & { txgio_owner_for_gate?: string | null })
          .txgio_owner_for_gate ?? null;

      const payload = buildTier1Payload(
        row,
        county.fips,
        county.name,
        landUse,
        nowIso,
        blockedFips,
        addressLandUse,
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
      if (payload.provenance.landUseAddressRecovered) {
        stats.facetHits.landUseAddressRecovered += 1;
      }
      if (payload.facetCoverage.acreage) stats.facetHits.acreage += 1;
      if (payload.facetCoverage.zoning) stats.facetHits.zoning += 1;
      if (payload.facetCoverage.envelope) stats.facetHits.envelopeDerived += 1;
      if (payload.envelope?.status === "ok") stats.facetHits.envelopeOk += 1;

      args.sampleSink(payload);

      const placeKey = placeKeyForNode(payload.parcelNodeId);
      const centroid = ring ? ringCentroid(ring) : { lat: 0, lng: 0 };
      computed.push({ placeKey, payload, centroid });
    }

    // ---- PHASE 2 (BATCH-READ PRIORS) ------------------------------------
    // ONE query fetches priors for every bakeable placeKey in the page. Runs
    // in dry-run too, so the dry-run monotonic decision reflects the DB state.
    const priors = await readSnapshotsBatch(
      pool,
      adapterKey,
      computed.map((c) => c.placeKey),
    );

    // ---- PHASE 3 (DECIDE + BATCH-WRITE) ---------------------------------
    // Apply the UNCHANGED shouldPromote per node, in page order, partitioning
    // into promote vs keptPriorMonotonic. Counts land byte-for-byte the same
    // as the per-node loop (kept / new / upgrade / baked). Promoted nodes are
    // upserted in one batched statement (chunked); dry-run skips only the
    // write, keeping every count intact.
    const decision = decidePagePromotions(computed, priors);
    stats.promotedNew += decision.promotedNew;
    stats.promotedUpgrade += decision.promotedUpgrade;
    stats.keptPriorMonotonic += decision.keptPriorMonotonic;
    stats.fabricationCorrected += decision.fabricationCorrected;
    stats.baked += decision.promotedNew + decision.promotedUpgrade;
    if (!dryRun) {
      await writeSnapshotsBatch(pool, adapterKey, decision.toWrite);
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

    // Ledger-driven block set (the gate's computed `block` verdicts). This is
    // NOT the set the bake acts on: the seed is the permanent floor, so the
    // EFFECTIVE block set is the UNION of the ledger blocks and the seed. A
    // county in the seed but scored something other than `block` (e.g.
    // Williamson 48491 -> `insufficient-sample`) is still blocked by the union,
    // so its `landUseGateBlocked` provenance is true and the fabrication
    // override fires. Before this union the raw ledger set was passed and
    // seed-blocked-but-not-ledger-blocked counties silently kept their
    // fabricated land-use (the Williamson override never fired).
    const ledgerBlockedFips = await loadLedgerBlockedFips(pool);
    const blockedFips = effectiveBlockedFips(ledgerBlockedFips);
    const isBlocked = blockedFips.has(county.fips);
    if (ledgerBlockedFips.has(county.fips)) {
      log(
        `land-use gate: county ${county.fips} prop_id join is BLOCKED by the ` +
          `coverage ledger — prop_id land-use is honest-ABSENT; land-use is ` +
          `RECOVERED via the owner-gated situs-address join (a fabricated prior ` +
          `snapshot's land-use is stripped or replaced by the verified code).`,
      );
    } else if (LANDUSE_JOIN_DISABLED_FIPS_SEED.has(county.fips)) {
      log(
        `land-use gate: county ${county.fips} prop_id join is BLOCKED by the ` +
          `gate-output seed (permanent floor; ledger verdict is not \`block\`) ` +
          `— prop_id land-use is honest-ABSENT; land-use is RECOVERED via the ` +
          `owner-gated situs-address join.`,
      );
    }

    // Address-recovery lookup: built ONLY for a blocked county (the only place
    // the recovery join fires). Non-blocked counties get an empty map and never
    // run the address path (addressJoinKey returns null for them anyway).
    const addressLandUse = isBlocked
      ? await fetchCountyLandUseByAddress(pool, county.fips)
      : new Map<string, AddressLandUseEntry>();
    if (isBlocked) {
      log(
        `address-recovery lookup for ${county.name}: ${addressLandUse.size} ` +
          `CAD rows keyed by normalized situs address (owner-gated per match).`,
      );
    }

    stats = await bakeCounty({
      pool,
      county,
      landUse,
      addressLandUse,
      adapterKey,
      pageSize,
      limit,
      dryRun,
      blockedFips,
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
  log(`  fabrication fixed: ${stats.fabricationCorrected} (gate-blocked land-use stripped from prior snapshot)`);
  log(`facet coverage (of bakeable):`);
  log(`  land-use:          ${stats.facetHits.landUse} (${pct(stats.facetHits.landUse)})`);
  log(`    via address-join:${stats.facetHits.landUseAddressRecovered} (owner-gated situs-address recovery)`);
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
