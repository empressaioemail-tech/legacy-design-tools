#!/usr/bin/env node
/**
 * Parcels PMTiles bake CLI — map 10x rebuild, Wave D3.
 *
 * Turns the self-hosted Central-Texas parcel geometry into a static
 * vector-tile pyramid (PMTiles) for the browse-all-CenTX map. The output
 * is served statically in D4 (this tool does NOT deploy or serve).
 *
 * DUAL-TABLE UNION (critical). The full Central-TX parcel fabric lives in
 * TWO tables with the SAME physical schema (migration 0053):
 *   - `txgio_parcel`         — the prod store the app reads (Comal 48091,
 *                              Hays 48209 today).
 *   - `txgio_parcel_staging` — the operator's bulk-load staging table for
 *                              the eight metro/gap counties (Travis,
 *                              Bexar, Williamson, Bell, McLennan,
 *                              Guadalupe, Bastrop, Caldwell).
 * The bake reads the UNION of both. Reading only prod silently omits the
 * metro core; reading only staging silently omits Comal/Hays. A county
 * present in BOTH is taken from prod (the authoritative store) and skipped
 * in staging, so a mid-migration state (operator promoting staging->prod)
 * never double-emits a parcel.
 *
 * Rows are stored one-per-intersecting-grid-cell (see txgioParcel schema),
 * so the bake reads DISTINCT ON (feature_index) per county — the same
 * dedupe the store readers use — to emit each parcel exactly once.
 *
 * FEATURE IDENTITY. Each emitted GeoJSON feature carries
 * `parcel_node_id = "{county_fips}:{normalizeCadPropId(prop_id)}"`,
 * computed via the SHARED `parcelNodeId` helper (imported, not
 * reinvented) so a parcel baked here and the same parcel fetched live
 * carry the SAME id. The tippecanoe run is invoked with
 * `--use-attribute-for-id=parcel_node_id` so the tile feature id IS the
 * node id, AND the value is kept as a feature PROPERTY as well, so R1's
 * renderer (promoteId defaults to the `parcel_node_id` property) keys on
 * it regardless of how tippecanoe resolves the tile id.
 *
 * LAND-USE. Several counties have a CAD appraisal roll loaded
 * (`cad_property`): Travis, Bastrop, Caldwell, Bexar, Bell, and others.
 * loadLandUse pulls ALL cad_property rows and is NOT county-gated, so any
 * county with a loaded roll and a matching numbering system joins (Bexar's
 * rows join at ~99% owner-match). For those, each parcel is joined (latest
 * tax year, coded rows only) to its `property_use_code` and stamped
 * `landUseCode` + a keyword-bucketable `landUseDescription` (via the shared
 * `ptadLandUseDescription`). Counties without a roll — and counties gated
 * off for numbering-mismatch (see next paragraph) — bake geometry-only with
 * uniform paint — still clickable, honestly neutral (no fabricated code).
 * The join uses the SAME key the cad:* brief adapters use:
 * `(county_fips, cad-normalized prop_id)`, via `landUseJoinKey` (see
 * ./lib/joinNormalize).
 *
 * DATA-INTEGRITY GATE (commitment #1 — honest absence over fabrication).
 * Williamson (48491) and Hays (48209) are GATED OFF: their TxGIO prop_ids do
 * NOT correspond to their CAD roll (Williamson's are the "R-account" form
 * over a different six-digit CAD numbering; Hays' are a divergent
 * bare-numeric system). A prior R-strip made Williamson's key COLLIDE with
 * unrelated CAD accounts, fabricating a different property's land-use onto
 * ~97k parcels (owner-match ~0.005%); Hays fabricated ~78k the same way
 * (~0.013%). `landUseJoinKey` returns null for these two FIPS, so they bake
 * land-use-absent (honest) until an external account crosswalk exists. The
 * R-strip is removed entirely — no other county carries an R-prefixed id, so
 * removing it drops no real join.
 *
 * RE-RUNNABLE + CONTENT-HASHED. Emits a GeoJSONSeq (newline-delimited)
 * export, runs tippecanoe to a temp PMTiles, then renames it to a
 * content-hashed final name `parcels.<sha256-12>.pmtiles`. When the
 * operator later promotes staging into prod or loads more CAD roll,
 * re-baking produces a fresh hash — D4 uploads the hashed name to GCS.
 *
 * Usage (from repo root):
 *   node node_modules/.pnpm/tsx@<v>/node_modules/tsx/dist/cli.mjs \
 *     artifacts/api-server/src/parcelsPmtilesBakeCli.ts \
 *     [--out-dir=./.pmtiles-bake] \
 *     [--counties=48453,48209,48021]   # subset; default: all present \
 *     [--export-only]                  # write GeoJSONSeq, skip tippecanoe \
 *     [--geojson=<path>]               # bake an existing export (skip DB) \
 *     [--tippecanoe=docker|<binary>]   # default: auto (native else docker) \
 *     [--min-zoom=0] [--max-zoom=16] \
 *     [--page-size=20000] [--limit=N]  # --limit caps parcels per county \
 *     [--layer=parcels]
 *
 * DATABASE_URL must point at the parcel Postgres (falls back to loading the
 * DEPLOYMENT_DATABASE_URL secret via gcloud, mirroring the fixture CLI).
 * Read-only: the bake never writes the parcel tables.
 *
 * Exit-bounded: connect -> stream export -> tippecanoe -> hash -> summary,
 * then exit. Exit 0 on success, 1 on fatal error or zero features.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

import { parcelNodeId } from "./lib/parcelNodeId";
import { landUseJoinKey } from "./lib/joinNormalize";
import { loadLedgerBlockedFips } from "./lib/joinIntegrityGate";
// The land-use description mapping lives in a dependency-free module (NOT
// imported from txgioParcelStore, which drags in @workspace/db and would
// throw on a missing DATABASE_URL at import time — this offline bake
// resolves its DB url lazily via gcloud).
import { ptadLandUseDescription } from "./lib/ptadLandUse";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// County registry (kept local so the bake needs no @workspace/cad-ingest dep;
// the fips->name mapping is the same ten counties unified in Wave D1/D2).
// ---------------------------------------------------------------------------

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

/** Tables read, in precedence order: prod wins over staging for a county. */
const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

function log(msg: string): void {
  console.log(`[parcels-bake] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[parcels-bake] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution — env, else the DEPLOYMENT_DATABASE_URL secret via
// gcloud (same fallback the capture-fixture CLI uses).
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
// Table + county discovery.
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
}

/**
 * Enumerate every county present across the two tables, prod winning on a
 * collision. Returns them in a stable order (fips asc) so a subset selection
 * and the summary are deterministic.
 */
async function discoverCounties(pool: pg.Pool): Promise<CountySource[]> {
  const seen = new Set<string>();
  const sources: CountySource[] = [];
  for (const table of PARCEL_TABLES) {
    if (!(await tableExists(pool, table))) {
      log(`table ${table} absent — skipping`);
      continue;
    }
    const r = await pool.query<{ county_fips: string; parcels: string }>(
      `SELECT county_fips, count(DISTINCT feature_index) AS parcels
         FROM ${table}
        GROUP BY county_fips`,
    );
    for (const row of r.rows) {
      const fips = row.county_fips;
      if (seen.has(fips)) {
        log(
          `county ${fips} present in ${table} but already taken from a ` +
            `higher-precedence table — skipping the staging copy`,
        );
        continue;
      }
      seen.add(fips);
      sources.push({
        fips,
        name: COUNTY_NAMES[fips] ?? fips,
        table,
        parcelCount: Number(row.parcels),
      });
    }
  }
  sources.sort((a, b) => a.fips.localeCompare(b.fips));
  return sources;
}

// ---------------------------------------------------------------------------
// Land-use join — one query per county, latest coded tax-year row per parcel.
// Keyed by normalizeCadPropId(prop_id), matching the store readers.
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
  // DISTINCT ON latest tax year, coded rows only. prop_id in cad_property is
  // already stored CAD-normalized (see cadPropertyLookup), so the join key is
  // prop_id verbatim on that side.
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
// Per-county streamed GeoJSONSeq export (keyset-paginated on feature_index,
// DISTINCT ON to collapse the one-row-per-cell duplication). Bounded memory:
// one page of parcels in flight at a time.
// ---------------------------------------------------------------------------

interface ExportStats {
  featureCount: number;
  withLandUse: number;
  withNodeId: number;
  perCounty: { fips: string; name: string; features: number; landUse: number }[];
}

async function writeLine(
  stream: NodeJS.WritableStream,
  line: string,
): Promise<void> {
  if (!stream.write(line)) {
    await once(stream, "drain");
  }
}

async function exportCounty(
  pool: pg.Pool,
  county: CountySource,
  landUse: Map<string, LandUse>,
  out: NodeJS.WritableStream,
  pageSize: number,
  limit: number | undefined,
  blockedFips: ReadonlySet<string>,
): Promise<{ features: number; landUse: number; nodeIds: number }> {
  let after = -1; // keyset cursor on feature_index (0-based in schema)
  let features = 0;
  let landUseHits = 0;
  let nodeIds = 0;
  for (;;) {
    const remaining =
      limit !== undefined ? Math.max(0, limit - features) : pageSize;
    if (remaining === 0) break;
    const pageLimit = Math.min(pageSize, remaining);
    const r = await pool.query<{
      feature_index: number;
      prop_id: string | null;
      situs_address: string | null;
      geometry: unknown;
    }>(
      `SELECT DISTINCT ON (feature_index)
              feature_index, prop_id, situs_address, geometry
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
      const properties: Record<string, unknown> = {
        county_fips: county.fips,
        countyName: county.name,
      };
      if (row.prop_id) properties.apn = row.prop_id;
      const nodeId = parcelNodeId(county.fips, row.prop_id);
      if (nodeId) {
        properties.parcel_node_id = nodeId;
        nodeIds += 1;
      }
      // situsAddress is the parcel's own public street address (on the
      // listing, the county site, the map click UX). It is kept.
      //
      // owner_name is NOT stamped: the CAD owner NAME is the private pairing
      // and this PMTiles archive is a public, bulk-downloadable, cache-forever
      // artifact. Publishing owner names on ~2.5M features would leak the names
      // of millions of Texans. The column is not even SELECTed above.
      if (row.situs_address) properties.situsAddress = row.situs_address;
      if (row.prop_id) {
        // The cad_property key is CAD-normalized (leading zeros stripped),
        // the same key the cad:* brief adapters join on. The store's raw
        // prop_id may carry leading zeros, so join on the normalized form.
        // landUseJoinKey enforces the per-county data-integrity gate: it
        // returns null for BLOCKED counties (the coverage ledger's computed
        // `block` verdicts, loaded once per run; seed fallback on an unscored
        // DB), so those parcels bake land-use-absent (honest) rather than a
        // fabricated collision.
        const joinKey = landUseJoinKey(county.fips, row.prop_id, blockedFips);
        const lu = joinKey != null ? landUse.get(joinKey) : undefined;
        if (lu) {
          properties.landUseCode = lu.landUseCode;
          const desc = ptadLandUseDescription(lu.landUseCode);
          if (desc) properties.landUseDescription = desc;
          properties.landUseSource = "cad-roll";
          properties.landUseVintage = lu.landUseVintage;
          landUseHits += 1;
        }
      }
      const feature = {
        type: "Feature",
        geometry: row.geometry,
        properties,
      };
      // GeoJSONSeq: one Feature object per line (tippecanoe reads this
      // streamingly without holding the whole set in memory).
      await writeLine(out, JSON.stringify(feature) + "\n");
      features += 1;
    }
    if (r.rows.length < pageLimit) break;
  }
  return { features, landUse: landUseHits, nodeIds };
}

// ---------------------------------------------------------------------------
// tippecanoe invocation (native binary or docker), then content-hash rename.
// ---------------------------------------------------------------------------

interface TippecanoePlan {
  mode: "native" | "docker";
  bin: string;
}

function resolveTippecanoe(pref: string | undefined): TippecanoePlan | null {
  if (pref && pref !== "docker" && pref !== "auto") {
    return { mode: "native", bin: pref };
  }
  if (pref !== "docker") {
    const probe = spawnSync("tippecanoe", ["--version"], { encoding: "utf8" });
    if (probe.status === 0 || (probe.stderr ?? "").includes("tippecanoe")) {
      return { mode: "native", bin: "tippecanoe" };
    }
    if (pref !== "auto" && pref !== undefined) return null;
  }
  const dockerProbe = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerProbe.status === 0) return { mode: "docker", bin: "docker" };
  return null;
}

function tippecanoeArgs(
  layer: string,
  minZoom: number,
  maxZoom: number,
  inPath: string,
  outPath: string,
): string[] {
  return [
    "-o",
    outPath,
    "-l",
    layer,
    "--minimum-zoom",
    String(minZoom),
    "--maximum-zoom",
    String(maxZoom),
    // Keep the WHOLE parcel fabric coherent when zoomed out instead of
    // cutting off: coalesce/drop the densest features as needed rather than
    // dropping everything, and simplify low zooms.
    "--drop-densest-as-needed",
    "--coalesce-densest-as-needed",
    "--simplification",
    "10",
    "--extend-zooms-if-still-dropping",
    // Feature identity for the highlight layer: parcel_node_id is a STRING
    // ("48453:12345"), and a vector-tile numeric feature id must be a
    // non-negative integer, so --use-attribute-for-id would only warn
    // ("... as feature ID is not a number") per feature (millions of them)
    // and set no usable id. R1's renderer keys feature-state on the
    // `parcel_node_id` PROPERTY via maplibre `promoteId` (which replaces
    // the tile id with the property value at runtime), so the load-bearing
    // carrier is the property — stamped on every feature by the exporter —
    // NOT the tile id. Passing --use-attribute-for-id here is therefore
    // omitted deliberately; set TIPPECANOE_ATTRIBUTE_ID=1 to re-enable it
    // if a future tippecanoe hashes string ids to a stable numeric surrogate.
    ...(process.env.TIPPECANOE_ATTRIBUTE_ID === "1"
      ? ["--use-attribute-for-id=parcel_node_id"]
      : []),
    "--force",
    "--read-parallel",
    inPath,
  ];
}

function runTippecanoe(
  plan: TippecanoePlan,
  layer: string,
  minZoom: number,
  maxZoom: number,
  geojsonPath: string,
  tmpOutPath: string,
): void {
  if (plan.mode === "native") {
    const args = tippecanoeArgs(layer, minZoom, maxZoom, geojsonPath, tmpOutPath);
    log(`tippecanoe ${args.join(" ")}`);
    execFileSync(plan.bin, args, { stdio: "inherit" });
    return;
  }
  // docker: mount the out dir, run inside container against basenames.
  // Both the GeoJSONSeq input and the PMTiles output live in outDir, so
  // mount that one dir at /data and reference each by basename.
  const workDir = dirname(resolve(tmpOutPath));
  const inBase = basename(geojsonPath);
  const outBase = basename(tmpOutPath);
  const containerArgs = tippecanoeArgs(
    layer,
    minZoom,
    maxZoom,
    `/data/${inBase}`,
    `/data/${outBase}`,
  );
  // Docker on Windows needs a msys-path-translation guard off for the mount.
  const mount = `${toDockerPath(workDir)}:/data`;
  // A CURRENT tippecanoe (>=2.x) is required for PMTiles output and the
  // --use-attribute-for-id / --coalesce-densest-as-needed flags. The old
  // klokantech/tippecanoe (v1.24) has none of them. Build a felt/tippecanoe
  // image locally (see the PR body Dockerfile) and pass its tag via
  // TIPPECANOE_DOCKER_IMAGE; the default matches that build tag.
  const image = process.env.TIPPECANOE_DOCKER_IMAGE ?? "tippecanoe-felt:latest";
  const args = [
    "run",
    "--rm",
    "-v",
    mount,
    image,
    "tippecanoe",
    ...containerArgs,
  ];
  log(`docker ${args.join(" ")}`);
  execFileSync("docker", args, { stdio: "inherit" });
}

/** C:\a\b -> //c/a/b so Docker Desktop mounts a Windows path. */
function toDockerPath(p: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!win) return p;
  return `//${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
}

async function contentHash12Async(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const fd = createReadStream(filePath);
  fd.on("data", (d) => hash.update(d));
  await once(fd, "end");
  return hash.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      "out-dir": { type: "string" },
      counties: { type: "string" },
      "export-only": { type: "boolean", default: false },
      geojson: { type: "string" },
      tippecanoe: { type: "string" },
      "min-zoom": { type: "string" },
      "max-zoom": { type: "string" },
      "page-size": { type: "string" },
      limit: { type: "string" },
      layer: { type: "string" },
    },
  });

  const outDir = resolve(values["out-dir"] ?? "./.pmtiles-bake");
  mkdirSync(outDir, { recursive: true });
  const layer = values.layer ?? "parcels";
  const minZoom = values["min-zoom"] !== undefined ? Number(values["min-zoom"]) : 0;
  const maxZoom = values["max-zoom"] !== undefined ? Number(values["max-zoom"]) : 16;
  const pageSize =
    values["page-size"] !== undefined ? Number(values["page-size"]) : 20000;
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const geojsonPath = join(outDir, "parcels.geojsonseq");

  const startedAt = Date.now();
  const stats: ExportStats = {
    featureCount: 0,
    withLandUse: 0,
    withNodeId: 0,
    perCounty: [],
  };

  // --geojson=<path>: skip the DB export and bake an existing GeoJSONSeq.
  if (values.geojson) {
    const provided = isAbsolute(values.geojson)
      ? values.geojson
      : resolve(values.geojson);
    if (!existsSync(provided)) fail(`--geojson not found: ${provided}`);
    log(`baking provided GeoJSONSeq: ${provided}`);
    await bakeAndReport(
      provided,
      outDir,
      layer,
      minZoom,
      maxZoom,
      values.tippecanoe,
      values["export-only"] ?? false,
      startedAt,
      null,
    );
    return;
  }

  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    // Neon over TLS; the deploy URL already carries sslmode.
    ssl: databaseUrl.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    max: 4,
  });

  try {
    let counties = await discoverCounties(pool);
    if (counties.length === 0) fail("no parcel counties found in either table");

    if (values.counties) {
      const want = new Set(
        values.counties.split(",").map((c) => c.trim()).filter(Boolean),
      );
      counties = counties.filter((c) => want.has(c.fips) || want.has(c.name));
      if (counties.length === 0) {
        fail(`--counties=${values.counties} matched none of the present counties`);
      }
    }

    log(
      `baking ${counties.length} counties: ` +
        counties.map((c) => `${c.fips}/${c.name}(${c.parcelCount})`).join(", "),
    );

    // Ledger-driven land-use block set (the gate's computed `block` verdicts);
    // empty on an unscored DB -> landUseJoinKey falls back to the gate-output
    // seed, so a fresh DB is never left un-gated.
    const blockedFips = await loadLedgerBlockedFips(pool);
    if (blockedFips.size > 0) {
      log(
        `land-use gate: ledger BLOCKS ${[...blockedFips].sort().join(", ")} ` +
          `— those counties bake land-use ABSENT (honest).`,
      );
    }

    const out = createWriteStream(geojsonPath, { encoding: "utf8" });
    for (const county of counties) {
      const landUse = await fetchCountyLandUse(pool, county.fips);
      log(
        `county ${county.fips}/${county.name} from ${county.table} ` +
          `(${county.parcelCount} parcels, ${landUse.size} CAD land-use rows)`,
      );
      const res = await exportCounty(
        pool,
        county,
        landUse,
        out,
        pageSize,
        limit,
        blockedFips,
      );
      stats.featureCount += res.features;
      stats.withLandUse += res.landUse;
      stats.withNodeId += res.nodeIds;
      stats.perCounty.push({
        fips: county.fips,
        name: county.name,
        features: res.features,
        landUse: res.landUse,
      });
      log(
        `  -> ${res.features} features (${res.landUse} land-use, ` +
          `${res.nodeIds} node-ids)`,
      );
    }
    out.end();
    await once(out, "finish");
  } finally {
    await pool.end();
  }

  if (stats.featureCount === 0) fail("zero features exported — nothing to bake");
  const sizeMb = (statSync(geojsonPath).size / 1_048_576).toFixed(1);
  log(
    `GeoJSONSeq export: ${stats.featureCount} features (${stats.withNodeId} ` +
      `with parcel_node_id, ${stats.withLandUse} with land-use), ${sizeMb} MB ` +
      `at ${geojsonPath}`,
  );

  await bakeAndReport(
    geojsonPath,
    outDir,
    layer,
    minZoom,
    maxZoom,
    values.tippecanoe,
    values["export-only"] ?? false,
    startedAt,
    stats,
  );
}

async function bakeAndReport(
  geojsonPath: string,
  outDir: string,
  layer: string,
  minZoom: number,
  maxZoom: number,
  tippecanoePref: string | undefined,
  exportOnly: boolean,
  startedAt: number,
  stats: ExportStats | null,
): Promise<void> {
  if (exportOnly) {
    log("--export-only: skipping tippecanoe. To bake:");
    log(
      `  tippecanoe -o parcels.pmtiles -l ${layer} --minimum-zoom ${minZoom} ` +
        `--maximum-zoom ${maxZoom} --drop-densest-as-needed ` +
        `--coalesce-densest-as-needed --simplification 10 ` +
        `--extend-zooms-if-still-dropping ` +
        `--use-attribute-for-id=parcel_node_id --force ${geojsonPath}`,
    );
    summarize(stats, null, null, startedAt);
    return;
  }

  const plan = resolveTippecanoe(tippecanoePref);
  if (!plan) {
    log(
      "tippecanoe not available (no native binary, no running docker). " +
        "GeoJSONSeq export is complete; run tippecanoe yourself:",
    );
    log(
      `  tippecanoe -o parcels.pmtiles -l ${layer} --minimum-zoom ${minZoom} ` +
        `--maximum-zoom ${maxZoom} --drop-densest-as-needed ` +
        `--coalesce-densest-as-needed --simplification 10 ` +
        `--extend-zooms-if-still-dropping ` +
        `--use-attribute-for-id=parcel_node_id --force ${geojsonPath}`,
    );
    summarize(stats, null, null, startedAt);
    return;
  }

  const tmpOut = join(outDir, "parcels.tmp.pmtiles");
  log(`baking PMTiles via ${plan.mode} tippecanoe (z${minZoom}-z${maxZoom})...`);
  runTippecanoe(plan, layer, minZoom, maxZoom, geojsonPath, tmpOut);
  if (!existsSync(tmpOut)) fail("tippecanoe produced no output file");

  const hash = await contentHash12Async(tmpOut);
  const finalName = `parcels.${hash}.pmtiles`;
  const finalPath = join(outDir, finalName);
  renameSync(tmpOut, finalPath);
  const pmSizeMb = (statSync(finalPath).size / 1_048_576).toFixed(1);
  log(`PMTiles: ${finalName} (${pmSizeMb} MB) at ${finalPath}`);
  summarize(stats, finalPath, `${pmSizeMb} MB`, startedAt);
}

function summarize(
  stats: ExportStats | null,
  pmtilesPath: string | null,
  pmtilesSize: string | null,
  startedAt: number,
): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- bake summary ----");
  if (stats) {
    log(`features:         ${stats.featureCount}`);
    log(`with node id:     ${stats.withNodeId}`);
    log(`with land-use:    ${stats.withLandUse}`);
    for (const c of stats.perCounty) {
      log(
        `  ${c.fips} ${c.name.padEnd(11)} ${String(c.features).padStart(8)} ` +
          `features  ${String(c.landUse).padStart(8)} land-use`,
      );
    }
  }
  if (pmtilesPath) {
    log(`pmtiles:          ${pmtilesPath} (${pmtilesSize})`);
  }
  log(`duration:         ${seconds}s`);
}

main().catch((err) => {
  console.error("[parcels-bake] FATAL:", err);
  process.exit(1);
});
