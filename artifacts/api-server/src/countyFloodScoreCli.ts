#!/usr/bin/env node
/**
 * Flood-rail coverage SCORER CLI.
 *
 * Mirrors `countyGeometryScoreCli.ts` for the `flood` rail
 * (`county_rail.rail_key = 'flood'`, atom family `flood-hazard-fact`).
 * Counts flood-hazard-fact atoms in the ATOMS store against DISTINCT
 * `feature_index` in `txgio_parcel` per county and upserts
 * `county_facet_coverage` rows with facet=`flood`.
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyFloodScoreCli.ts --county=48261 [--dry-run]
 *   tsx artifacts/api-server/src/countyFloodScoreCli.ts --all [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import { classifyFacet, type FacetScore } from "./countyCoverageScoreCli";

const { Pool } = pg;

const FLOOD_THRESHOLD_PCT = 95;

function log(msg: string): void {
  console.log(`[flood-score] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[flood-score] ERROR: ${msg}`);
  process.exit(1);
}

function resolveViaGcloud(
  envVar: string,
  secretName: string,
  projectEnvVar: string,
  defaultProject: string,
): string {
  const direct = process.env[envVar]?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  const project = process.env[projectEnvVar] ?? defaultProject;
  try {
    const out = execFileSync(
      gcloud,
      [
        "secrets",
        "versions",
        "access",
        "latest",
        `--secret=${secretName}`,
        `--project=${project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (out) return out;
  } catch (err) {
    fail(
      `${envVar} not set and gcloud secret fetch failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return fail(`${envVar} could not be resolved`);
}

function resolveAtomsDatabaseUrl(): string {
  return resolveViaGcloud(
    "DATABASE_URL",
    "DATABASE_URL",
    "GCP_ATOMS_PROJECT",
    "hauska-prod-497015",
  );
}

function resolveDeploymentDatabaseUrl(): string {
  return resolveViaGcloud(
    "DEPLOYMENT_DATABASE_URL",
    "DEPLOYMENT_DATABASE_URL",
    "GCP_PROJECT",
    "legacy-design-tools-prod",
  );
}

function makePool(connectionString: string, max: number): pg.Pool {
  return new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
    max,
  });
}

async function readAtomCountsByCounty(
  atomsPool: pg.Pool,
): Promise<Map<string, number>> {
  const { rows } = await atomsPool.query<{ fips: string | null; n: string }>(
    `SELECT left(entity_id, 5) AS fips, count(*) AS n
       FROM atoms
      WHERE entity_type = 'flood-hazard-fact'
        AND entity_id ~ '^[0-9]{5}:'
      GROUP BY 1`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.fips) continue;
    out.set(r.fips, Number(r.n));
  }
  return out;
}

async function readFeatureCount(
  deployPool: pg.Pool,
  fips: string,
): Promise<{ features: number; table: string } | null> {
  for (const table of ["txgio_parcel", "txgio_parcel_staging"] as const) {
    const exists = await deployPool.query<{ r: string | null }>(
      "SELECT to_regclass($1) AS r",
      [table],
    );
    if (exists.rows[0]?.r == null) continue;
    const r = await deployPool.query<{ features: string }>(
      `SELECT count(DISTINCT feature_index) AS features FROM ${table} WHERE county_fips = $1`,
      [fips],
    );
    const features = Number(r.rows[0]?.features ?? 0);
    if (features > 0) return { features, table };
  }
  return null;
}

async function readManifestCounties(
  deployPool: pg.Pool,
): Promise<Map<string, string>> {
  const { rows } = await deployPool.query<{
    county_fips: string;
    county_name: string;
  }>("SELECT county_fips, county_name FROM county_manifest ORDER BY county_fips");
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.county_fips, r.county_name);
  return out;
}

export interface FloodCountyScore {
  fips: string;
  name: string;
  atomCount: number;
  featureCount: number | null;
  featureTable: string | null;
  facet: FacetScore;
  railState: "satisfied-present" | "not-yet";
}

export function scoreFlood(input: {
  fips: string;
  name: string;
  atomCount: number;
  featureCount: number | null;
}): FloodCountyScore {
  const { fips, name, atomCount, featureCount } = input;
  const sourcePresent = featureCount != null && featureCount > 0;
  const rawCoveragePct = sourcePresent
    ? Math.min(100, (atomCount / (featureCount as number)) * 100)
    : 0;

  const facet = classifyFacet({
    facet: "flood",
    rawCoveragePct,
    sourcePresent,
    verdict: null,
    ownerMatchRate: null,
    source: sourcePresent ? "flood-hazard-fact-atom-count" : null,
    sourceVintage: null,
    sampled: 0,
  });

  const railState: "satisfied-present" | "not-yet" =
    facet.honestCoveragePct >= FLOOD_THRESHOLD_PCT
      ? "satisfied-present"
      : "not-yet";

  return {
    fips,
    name,
    atomCount,
    featureCount,
    featureTable: null,
    facet,
    railState,
  };
}

async function upsertLedger(
  deployPool: pg.Pool,
  score: FloodCountyScore,
): Promise<void> {
  const f = score.facet;
  await deployPool.query(
    `INSERT INTO county_facet_coverage
       (county_fips, facet, honest_coverage_pct, integrity_verdict,
        owner_match_rate, source, source_vintage, sampled, classification,
        rail_state, threshold_pct, verification_method, verified_by_instrument,
        artifact_path, checked_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
     ON CONFLICT (county_fips, facet) DO UPDATE SET
       honest_coverage_pct    = EXCLUDED.honest_coverage_pct,
       integrity_verdict      = EXCLUDED.integrity_verdict,
       owner_match_rate       = EXCLUDED.owner_match_rate,
       source                 = EXCLUDED.source,
       source_vintage         = EXCLUDED.source_vintage,
       sampled                = EXCLUDED.sampled,
       classification         = EXCLUDED.classification,
       rail_state             = EXCLUDED.rail_state,
       threshold_pct          = EXCLUDED.threshold_pct,
       verification_method    = EXCLUDED.verification_method,
       verified_by_instrument = EXCLUDED.verified_by_instrument,
       artifact_path          = EXCLUDED.artifact_path,
       checked_at             = now(),
       last_verified_at       = now()`,
    [
      score.fips,
      "flood",
      f.honestCoveragePct.toFixed(2),
      f.integrityVerdict,
      f.ownerMatchRate != null ? f.ownerMatchRate.toFixed(4) : null,
      f.source,
      f.sourceVintage,
      f.sampled,
      f.classification,
      score.railState,
      FLOOD_THRESHOLD_PCT.toFixed(2),
      "sweep",
      "countyFloodScoreCli.ts",
      `atoms:entity_type=flood-hazard-fact,countyFips=${score.fips}`,
    ],
  );
}

function reportCounty(score: FloodCountyScore, dryRun: boolean): void {
  const f = score.facet;
  log(
    `${dryRun ? "DRY-RUN " : ""}${score.fips}/${score.name}: ` +
      `atoms=${score.atomCount} features=${score.featureCount ?? "n/a"} ` +
      `(${score.featureTable ?? "no source table"}) ` +
      `coverage=${f.honestCoveragePct.toFixed(2)}% -> ${f.classification} -> rail_state=${score.railState}`,
  );
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      county: { type: "string" },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dryRun = values["dry-run"] ?? false;
  const all = values.all ?? false;
  const single = values.county?.trim();

  if (!all && !single) {
    fail("pass --county=<fips> or --all");
  }

  const startedAt = Date.now();
  const atomsPool = makePool(resolveAtomsDatabaseUrl(), 2);
  const deployPool = makePool(resolveDeploymentDatabaseUrl(), 4);

  let wrote = 0;
  let skippedNoFeatures = 0;
  const scores: FloodCountyScore[] = [];
  try {
    const atomCounts = await readAtomCountsByCounty(atomsPool);
    log(`atoms store: ${atomCounts.size} counties carry flood-hazard-fact atoms`);

    const manifestCounties = await readManifestCounties(deployPool);
    let targets: string[];
    if (all) {
      targets = Array.from(atomCounts.keys()).sort();
      log(`--all target set: ${targets.length} counties with flood-hazard-fact atoms`);
    } else {
      targets = [single as string];
    }

    for (const fips of targets) {
      const atomCount = atomCounts.get(fips) ?? 0;
      const name = manifestCounties.get(fips) ?? fips;
      const featureInfo = await readFeatureCount(deployPool, fips);
      if (!featureInfo) {
        log(
          `county ${fips}/${name} has ${atomCount} flood-hazard-fact atoms but NO txgio_parcel rows — skipping (no denominator)`,
        );
        skippedNoFeatures += 1;
        continue;
      }
      const score = scoreFlood({
        fips,
        name,
        atomCount,
        featureCount: featureInfo.features,
      });
      score.featureTable = featureInfo.table;
      reportCounty(score, dryRun);
      scores.push(score);
      if (!dryRun) {
        await upsertLedger(deployPool, score);
        wrote += 1;
      }
    }
  } finally {
    await atomsPool.end();
    await deployPool.end();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const satisfied = scores.filter((s) => s.railState === "satisfied-present").length;
  log("---- flood-score summary ----");
  log(`mode:                ${dryRun ? "DRY-RUN (no ledger writes)" : "WRITE"}`);
  log(`counties scored:     ${scores.length}`);
  log(`counties skipped:    ${skippedNoFeatures} (no txgio_parcel denominator)`);
  log(`satisfied-present:   ${satisfied}`);
  log(`not-yet (below 95%): ${scores.length - satisfied}`);
  log(`ledger writes:       ${dryRun ? 0 : wrote}`);
  log(`duration:            ${seconds}s`);
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
    console.error("[flood-score] FATAL:", err);
    process.exit(1);
  });
}
