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
 *     [--prop-ids-file=<path>]            # scoped: listed prop ids only
 *
 * `--prop-ids-file=<path>` (scoped mode): restricts the parcel READ (and
 * therefore promote) to exactly the prop ids listed in the file — one per
 * line, either a raw CAD prop id ("31131") or a full parcelNodeId
 * ("48021:31131"; the county-fips prefix is stripped; --county still
 * governs which county table is queried). Ids are normalized the same way
 * `parcelNodeId.ts` normalizes CAD prop ids (leading zeros stripped) and
 * deduped before use. WITHOUT this flag the CLI is the whole-county path;
 * this flag only ever narrows. Summary reports listSize / matched /
 * notFoundInParcelStore so roster mismatches are visible before any write.
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
import { readFileSync, realpathSync } from "node:fs";
import pg from "pg";

import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import { parcelNodeId, normalizeCadPropId } from "./lib/parcelNodeId";
import {
  landUseJoinKey,
  addressJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
} from "./lib/joinNormalize";
import {
  fetchCountyLandUseRoll,
  loadLedgerBlockedFips,
  resolveAddressLandUse,
  type AddressLandUseEntry,
} from "./lib/joinIntegrityGate";
import { ptadLandUseDescription } from "./lib/ptadLandUse";
import { contentHashForPayload } from "./lib/placeLayerUtils";
import { ringCentroid, type Ring } from "./lib/nodeFacetBakeTier1";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants";
import {
  assembleTier1Payload,
  COUNTY_NAMES,
  effectiveBlockedFips,
  firstRing,
  TIER1_FACET_SCHEMA_VERSION,
  type BaseFacts,
  type LandUseSource,
  type Tier1FacetPayload,
} from "./lib/nodeFacetTier1Assemble";
import {
  columnExists,
  fetchParcelRowsByPropIds,
  parcelSelectList,
  PARCEL_TABLES,
  tableExists,
} from "./lib/nodeFacetTier1ParcelJoin";

const { Pool } = pg;

// Re-exported from the side-effect-free constants module so the server boot
// graph can pull the adapter key WITHOUT importing this bake CLI (whose
// entrypoint guard misfires in the prod bundle and crashes boot). The CLI's
// own uses below are unchanged.
export { TIER1_ADAPTER_KEY };

// The payload type, the county names, the ring reader, the effective block
// set and the schema version moved to `./lib/nodeFacetTier1Assemble.ts` on
// 2026-08-28 (OPS-19 A-025) so the conformant publish bake runs the SAME
// assembly by import. Re-exported here so existing importers (the unit test,
// `nodeFacetBakeTier2Cli.ts`) keep their paths. The conformant bake must NOT
// import this module: its entrypoint guard is true inside the esbuild publish
// bundle and would run `main()`.
export {
  COUNTY_NAMES,
  effectiveBlockedFips,
  firstRing,
  TIER1_FACET_SCHEMA_VERSION,
};
export type { BaseFacts, LandUseSource, Tier1FacetPayload };

function log(msg: string): void {
  console.log(`[node-facet-bake-t1] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[node-facet-bake-t1] ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Parse a `--prop-ids-file`: one id per line, blank lines and `#`-prefixed
 * comment lines ignored. Each line may be a raw prop id ("31131") or a full
 * `county:propId` parcelNodeId ("48021:31131") — the county prefix (if
 * present) is stripped since --county already selects the county. Every
 * surviving id must be non-empty; throws loud on an empty file or any
 * unparseable line.
 */
export function parsePropIdsFile(raw: string): Set<string> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("--prop-ids-file is empty (no usable lines)");
  }
  const ids = new Set<string>();
  for (const line of lines) {
    const afterColon = line.includes(":") ? line.split(":").pop()! : line;
    const trimmed = afterColon.trim();
    if (!trimmed) {
      throw new Error(`--prop-ids-file: unparseable line "${line}"`);
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `--prop-ids-file: line "${line}" is not a positive integer prop id`,
      );
    }
    ids.add(normalizeCadPropId(trimmed));
  }
  return ids;
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
  /**
   * Whether `zoning_jurisdiction` (PIP cityKey provenance) is present.
   * Absent on staging / pre-0062 tables — resolve falls back to situs only.
   */
  hasZoningJurisdiction: boolean;
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
      const hasZoningJurisdiction = await columnExists(
        pool,
        table,
        "zoning_jurisdiction",
      );
      return {
        fips,
        name: COUNTY_NAMES[fips] ?? fips,
        table,
        parcelCount: n,
        hasZoning,
        hasZoningJurisdiction,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Land-use join — one query per county at the DECLARED CAD vintage (L17).
// Looked up via landUseJoinKey(countyFips, prop_id), which normalizes the key
// AND enforces the per-county data-integrity gate (Williamson 48491 / Hays
// 48209 return null -> land-use-absent). Undeclared counties return empty
// (honest), never max-year fallback. Comal (no roll / undeclared) yields an
// empty map -> every node bakes land-use-absent, honestly.
// ---------------------------------------------------------------------------

interface LandUse {
  landUseCode: string;
  landUseVintage: string;
}

// The query itself lives in `./lib/joinIntegrityGate.ts` so the conformant
// bake reads the SAME upstream through the SAME function. One derivation, no
// second copy to drift (F-06 land-use projection, 2026-08-31). CAD-to-CAD:
// seed does NOT apply. Seed risk was TxGIO-to-CAD. 48209 and 48491 are
// clear. Do not re-impose the seed. Join key is prop_id, never seed.
async function fetchCountyLandUse(
  pool: pg.Pool,
  fips: string,
): Promise<Map<string, LandUse>> {
  return (await fetchCountyLandUseRoll(pool, fips)).byPropId;
}

// ---------------------------------------------------------------------------
// SITUS-ADDRESS land-use lookup — the RECOVERY source for prop_id-gate-blocked
// counties (Williamson/Hays). Keyed by normalized situs address at the
// DECLARED vintage. DISTINCT ON collapses address collisions within that year
// only (deterministic prop_id tie-break; never tax_year DESC). Carries the CAD
// owner_name so the per-match owner gate (`resolveAddressLandUse`) can verify
// each match; the owner is used ONLY for gating and never enters the baked
// payload. READ-ONLY.
// ---------------------------------------------------------------------------

async function fetchCountyLandUseByAddress(
  pool: pg.Pool,
  fips: string,
): Promise<Map<string, AddressLandUseEntry>> {
  const out = new Map<string, AddressLandUseEntry>();
  const declared = tryResolveDeclaredCadVintage(fips);
  if (!declared) return out;
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
        AND tax_year = $2
        AND property_use_code IS NOT NULL
        AND situs_address IS NOT NULL
        AND situs_address <> ''
      ORDER BY upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g')),
               prop_id`,
    [declared.countyFips, declared.taxYear],
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

// `BaseFacts`, `LandUseSource` and `Tier1FacetPayload` live in
// `./lib/nodeFacetTier1Assemble.ts` (re-exported above).

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
  /** Selected by `parcelSelectList` (both parcel tables carry it); optional for fixtures. */
  situs_zip?: string | null;
  zoning_district: string | null;
  zoning_jurisdiction: string | null;
  source_vintage: string | null;
  geometry: unknown;
  /** TxGIO owner — for the address-join per-match gate ONLY; never persisted. */
  txgioOwnerForGate?: string | null;
}

// `firstRing` and `effectiveBlockedFips` live in
// `./lib/nodeFacetTier1Assemble.ts` (re-exported above).

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

  // --- Zoning, envelope, acreage, coverage, provenance: the SHARED assembly
  // (`./lib/nodeFacetTier1Assemble.ts`), the same code the conformant publish
  // bake runs. Byte-for-byte the derivation that used to sit here.
  return assembleTier1Payload({
    nodeId,
    countyFips,
    countyName,
    facetSchemaVersion: TIER1_FACET_SCHEMA_VERSION,
    apn: str(row.prop_id),
    situsAddress: str(row.situs_address),
    situsCity: str(row.situs_city),
    situsState: str(row.situs_state),
    situsZip: str(row.situs_zip),
    landUse: luFacet,
    landUseAddressRecovered,
    landUseGateBlocked,
    ring,
    zoningDistrictRaw: row.zoning_district,
    zoningJurisdictionRaw: row.zoning_jurisdiction,
    parcelSource: "txgio",
    parcelVintage: str(row.source_vintage),
    nowIso,
    onSitusFallback: ({ cityKey, situsCity }) => {
      console.warn(
        `[node-facet-bake-t1] situs fallback jurisdiction=${cityKey} ` +
          `situs_city=${situsCity} county=${countyFips} ` +
          `feature_index=${row.feature_index}`,
      );
    },
  });
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
  const rawConf = payload.envelope?.confidence;
  const conf = typeof rawConf === "number" && Number.isFinite(rawConf) ? rawConf : 0;
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
 * Does a fresh Bastrop B3 re-bake remove the known-invalid legacy
 * Public/Institutional envelope? This is deliberately narrower than a general
 * setback downgrade: only the live B3 Place Type codes, only Bastrop County,
 * only the old P Public/Institutional district, and only the cited
 * honest-empty decline qualify.
 */
function isBastropB3SetbackCorrection(
  prior: Tier1FacetPayload,
  next: Tier1FacetPayload,
): boolean {
  const zoningCode = next.zoning?.district?.trim().toUpperCase() ?? "";
  const isB3PlaceType =
    /^P-[1-5](?:$|[-_\s])/.test(zoningCode) ||
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(zoningCode) ||
    /^PDD(?:$|[-_\s])/.test(zoningCode);
  return (
    next.countyFips === "48021" &&
    isB3PlaceType &&
    next.envelope?.status === "declined" &&
    (next.envelope.declineReason === "setback-table-pending" ||
      next.envelope.declineReason === "atom_path_pending") &&
    next.facetCoverage.envelope === false &&
    prior.envelope?.district === "P Public/Institutional"
  );
}

/**
 * Force-replace an invented envelope district when a fresh re-bake declines
 * for unmatched zoning. Without this, monotonic scoring keeps the invented
 * ok/no-buildable-area prior forever (e.g. Lockhart PDD painted as RHD).
 */
function isUnmatchedZoningCorrection(
  prior: Tier1FacetPayload,
  next: Tier1FacetPayload,
): boolean {
  const zoningCode = next.zoning?.district?.trim() ?? "";
  if (!zoningCode) return false;
  if (next.envelope?.status !== "declined") return false;
  if (
    next.envelope.declineReason !== "setback-table-pending" &&
    next.envelope.declineReason !== "atom_path_pending"
  ) {
    return false;
  }
  if (next.facetCoverage.envelope !== false) return false;
  if (!prior.envelope || prior.envelope.status === "declined") return false;
  const priorDistrict = prior.envelope.district?.trim() ?? "";
  if (!priorDistrict) return false;
  const priorCode = priorDistrict.split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  const nextCode = zoningCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return priorCode !== nextCode;
}

/**
 * Force-replace a stamped invent (null zoning painted as a real district,
 * e.g. Bexar → I-2) when the fresh bake declines with no-zoning-stamp and
 * keeps only a conservative estimate. Without this, mono keeps the invent.
 *
 * Scoped tightly: prior must ALSO have had no zoning stamp. A matched-zoning
 * prior that a worse re-bake strips to null zoning is a normal mono reject,
 * not this correction.
 */
function isAbsentZoningInventCorrection(
  prior: Tier1FacetPayload,
  next: Tier1FacetPayload,
): boolean {
  if (next.zoning?.district?.trim()) return false;
  if (prior.zoning?.district?.trim()) return false;
  if (next.envelope?.status !== "declined") return false;
  if (next.envelope.declineReason !== "no-zoning-stamp") return false;
  if (prior.envelope?.declineReason === "no-zoning-stamp") return false;
  const priorDistrict = prior.envelope?.district?.trim() ?? "";
  return priorDistrict.length > 0;
}

/**
 * Anti-zombie cut: force replace any prior product envelope (multiply-era)
 * with the fresh atom_path_pending decline so Tier-1 never keeps zombie
 * envelope truth after the cutover.
 */
function isAtomPathEnvelopeRetirement(
  prior: Tier1FacetPayload,
  next: Tier1FacetPayload,
): boolean {
  if (next.envelope?.status !== "declined") return false;
  if (next.envelope.declineReason !== "atom_path_pending") return false;
  if (prior.envelope?.declineReason === "atom_path_pending") return false;
  if (!prior.envelope) return false;
  return (
    prior.facetCoverage.envelope === true ||
    prior.envelope.status === "ok" ||
    prior.envelope.status === "no-buildable-area"
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
 * bypass. It fires only for a gate-blocked land-use correction, the known
 * Bastrop B3 P-code/Public-Institutional correction, an unmatched-zoning
 * correction that replaces an invented district with setback-table-pending,
 * or an absent-zoning invent correction (stamped district → no-zoning-stamp).
 * Any other downgrade still takes the monotonic path and is rejected.
 */
export function shouldPromote(
  prior: Tier1FacetPayload | null,
  next: Tier1FacetPayload,
): boolean {
  if (!prior) return true;
  // Fabrication-correction: force the strip of a gate-blocked county's
  // previously-promoted (fabricated) land-use, even though it lowers the score.
  if (isGateBlockedLandUseCorrection(prior, next)) return true;
  // Map-truth correction: force removal of the legacy P Public/Institutional
  // envelope when a Bastrop B3 Place Type now resolves to honest-empty.
  if (isBastropB3SetbackCorrection(prior, next)) return true;
  // Map-truth correction: force decline when an explicit GIS code no longer
  // matches any setback row (stop keeping invented districts like PDD→RHD).
  if (isUnmatchedZoningCorrection(prior, next)) return true;
  // Map-truth correction: force honest absent-zoning decline over a prior that
  // stamped the conservative row (e.g. I-2) as if it were a real district.
  if (isAbsentZoningInventCorrection(prior, next)) return true;
  if (isAtomPathEnvelopeRetirement(prior, next)) return true;
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
  /** Scoped runs only (`--prop-ids-file`). */
  scoped?: {
    listSize: number;
    matched: number;
    notFoundInParcelStore: string[];
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
  propIds?: Set<string>;
}): Promise<CountyStats> {
  const { pool, county, landUse, addressLandUse, adapterKey, pageSize, limit, dryRun } =
    args;
  const { blockedFips, propIds } = args;
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
  const scoped = propIds !== undefined && propIds.size > 0;
  const foundPropIds = new Set<string>();

  // The SELECT list (honest NULL projections for absent columns; owner only
  // for the address-recovery gate) is shared with the conformant bake.
  const selectList = parcelSelectList(county, needsOwnerForGate);

  /** Process one fetched page of parcel rows (shared by county-wide + scoped). */
  async function processParcelPage(
    rows: (ParcelRow & { txgio_owner_for_gate: string | null })[],
  ): Promise<void> {
    const computed: ComputedNode[] = [];

    for (const row of rows) {
      if (scoped && row.prop_id) {
        foundPropIds.add(normalizeCadPropId(row.prop_id));
      }
      stats.parcelsSeen += 1;

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

    const priors = await readSnapshotsBatch(
      pool,
      adapterKey,
      computed.map((c) => c.placeKey),
    );

    const decision = decidePagePromotions(computed, priors);
    stats.promotedNew += decision.promotedNew;
    stats.promotedUpgrade += decision.promotedUpgrade;
    stats.keptPriorMonotonic += decision.keptPriorMonotonic;
    stats.fabricationCorrected += decision.fabricationCorrected;
    stats.baked += decision.promotedNew + decision.promotedUpgrade;
    if (!dryRun) {
      await writeSnapshotsBatch(pool, adapterKey, decision.toWrite);
    }
  }

  if (scoped) {
    const idList = [...propIds!];
    for (const chunk of chunkItems(idList, pageSize)) {
      if (limit !== undefined && stats.parcelsSeen >= limit) break;
      // The scoped read is the shared parcel join (same SELECT the conformant
      // bake runs, keyed by county + prop_id).
      const rows = await fetchParcelRowsByPropIds(
        pool,
        county.fips,
        county,
        chunk,
        needsOwnerForGate,
      );
      if (rows.length === 0) continue;
      const remaining =
        limit !== undefined ? Math.max(0, limit - stats.parcelsSeen) : rows.length;
      await processParcelPage(rows.slice(0, remaining));
      if (limit !== undefined && stats.parcelsSeen >= limit) break;
    }
    stats.scoped = {
      listSize: propIds!.size,
      matched: foundPropIds.size,
      notFoundInParcelStore: [...propIds!].filter((id) => !foundPropIds.has(id)),
    };
    return stats;
  }

  for (;;) {
    const remaining =
      limit !== undefined ? Math.max(0, limit - stats.parcelsSeen) : pageSize;
    if (remaining === 0) break;
    const pageLimit = Math.min(pageSize, remaining);
    const r = await pool.query<ParcelRow & { txgio_owner_for_gate: string | null }>(
      `SELECT DISTINCT ON (feature_index)
              ${selectList}
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
    }
    await processParcelPage(r.rows);

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
      "prop-ids-file": { type: "string" },
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

  let propIds: Set<string> | undefined;
  if (values["prop-ids-file"] !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(values["prop-ids-file"], "utf8");
    } catch (err) {
      fail(
        `--prop-ids-file could not be read: ${values["prop-ids-file"]} (${(err as Error).message})`,
      );
    }
    try {
      propIds = parsePropIdsFile(raw);
    } catch (err) {
      fail(`--prop-ids-file: ${(err as Error).message}`);
    }
    log(
      `scoped mode: --prop-ids-file=${values["prop-ids-file"]} (${propIds.size} distinct prop ids requested)`,
    );
  }

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
        `(${propIds ? propIds.size + " scoped prop ids" : county.parcelCount + " parcels"})` +
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
      propIds,
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

  if (stats.scoped) {
    log("---- scoped mode (--prop-ids-file) ----");
    log(`listSize:              ${stats.scoped.listSize}`);
    log(`matched (in store):    ${stats.scoped.matched}`);
    log(`notFoundInParcelStore: ${stats.scoped.notFoundInParcelStore.length}`);
    if (stats.scoped.notFoundInParcelStore.length > 0) {
      log(`  ids: ${stats.scoped.notFoundInParcelStore.join(", ")}`);
    }
  }

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
