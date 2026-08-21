#!/usr/bin/env node
/**
 * Geometry-rail coverage SCORER CLI.
 *
 * Fixes the defect the master planner verified live 2026-08-09: the
 * `geometry` rail (ordinal 1, `county_rail.rail_key = 'geometry'`) declares
 * `atomFamilyState: 'present'` (parcel-node shipped in atom contract 1.13.0,
 * hauska-engine PR #282 registered it) but `hasWriter: false` — no scorer
 * ever counted the 331,472 `parcel-node` atoms living in the atoms store
 * against the parcel universe, so every county's geometry cell renders
 * `no-writer` regardless of how many atoms exist, and `texasCompletenessPct`
 * cannot move no matter how many counties get atom-written.
 *
 * STORE SPLIT — the hard part. `parcel-node` atoms live in the ATOMS store
 * (`DATABASE_URL`, project `hauska-prod-497015`, database `hauska_mcp`).
 * `county_manifest` / `county_facet_coverage` / `county_rail` / `txgio_parcel`
 * live in the DEPLOYMENT store (`DEPLOYMENT_DATABASE_URL`, project
 * `legacy-design-tools-prod`, database `neondb`). Verified 2026-08-09: both
 * secrets resolve to the SAME Neon endpoint (`ep-lucky-truth-apodo8hr`) but
 * different DATABASES on that endpoint, so a single `pg.Pool` cannot see
 * both — this script opens TWO pools, one per store, and joins their results
 * in application code (a single count-by-county query against each side,
 * joined in JS by fips — no cross-database SQL, no dblink/FDW). This is the
 * same shape `countyCoverageScoreCli.ts` and `countyRailRefreshCli.ts` both
 * already use for DATABASE_URL-vs-DEPLOYMENT_DATABASE_URL resolution
 * (`resolveDatabaseUrl` / `resolveDeploymentDatabaseUrl` below); no new
 * bridging mechanism is invented here, this generalizes the existing one to
 * two simultaneous connections instead of an either/or fallback.
 *
 * DENOMINATOR CHOICE. Coverage is (counties `parcel-node` atom count) /
 * (DISTINCT `feature_index` in `txgio_parcel` for that county) — the
 * SOURCE-FEATURE count, not the raw row count. `txgio_parcel` carries
 * multiple rows per feature (history/versioning — Kenedy is 2,400 rows for
 * 538 features, a ~4.5x multiplier), matching the pattern
 * `countyCoverageScoreCli.ts`'s `locateCounty`/`measureCoverage` already use
 * (`count(DISTINCT feature_index)`, `SELECT DISTINCT ON (feature_index)`
 * throughout). Using the row count as the denominator would understate
 * geometry coverage roughly 4x on a rural county like Kenedy (529/2400 =
 * 22% vs the true 529/538 = 98.3%) — the feature is the real-world parcel;
 * the extra rows are not extra parcels.
 *
 * Facet scored: `geometry` — honest coverage = parcel-node atoms for the
 * county / DISTINCT feature_index in txgio_parcel for the county. No owner
 * oracle (verdict is always `n/a`, matching zoning/envelope's pattern in
 * `countyCoverageScoreCli.ts`). Classification reuses `classifyFacet` from
 * that file unmodified (no source -> true-source-gap; source present ->
 * real-at-ceiling; there is no gate verdict for this facet, so
 * fabricated-blocked/needs-crosswalk never fire here).
 *
 * THRESHOLD / rail_state. The geometry rail's declared threshold is 95%
 * (`COUNTY_RAIL_DECLARATION` in `countyRailDimension.ts`). A county whose
 * honest coverage is >= threshold writes `rail_state = 'satisfied-present'`;
 * below threshold writes `rail_state = 'not-yet'` with the real
 * honest_coverage_pct stored (never `satisfied-present`, per the ruling
 * that PARTIAL/below-threshold counties render their real number and
 * contribute ZERO to the Texas rollup — see `countyLedger.ts`
 * `isSatisfiedCell`/`computeTexasRollup`). This mirrors why 18 of 19 scored
 * zoning cells contribute nothing today: `isPartial` there is computed at
 * query time when `rail_state = 'satisfied-present'` AND coverage <
 * threshold; this script does not rely on that path (it never marks a
 * below-threshold county `satisfied-present`), which is a stricter, more
 * direct way to express the same standing ruling and avoids depending on a
 * query-time flag this write-side script cannot see.
 *
 * HONEST ABSENCE (L7). When a county has no txgio_parcel denominator,
 * `satisfied-absent` is writable ONLY with an explicit positive determination
 * (`absenceBasis` + `verifiedByInstrument`). Missing or incomplete evidence
 * fail-closes to `not-yet` — never invent absence from a null feature count
 * alone. CLI: `--honest-absent=BASIS --artifact=PATH --county=FIPS`.
 *
 * `countyCoverageScoreCli.ts`'s own upsertLedger does NOT write
 * `rail_state`/`threshold_pct` (verified 2026-08-09: live `land-use`/
 * `envelope` rows have NULL rail_state; the 19 `satisfied-present` `zoning`
 * rows came from an earlier, separate stamp/backfill process with
 * source='' and pre-manifest-sprint timestamps, not from that CLI's current
 * write path). This script writes both columns directly since the manifest
 * grid's `no-atom`/`no-writer`/`not-yet`/`satisfied-*` precedence in
 * `countyLedger.ts` reads `rail_state` from the stored row.
 *
 * READ-ONLY on `atoms` (atoms store) and `txgio_parcel`/`county_manifest`
 * (deployment store). The ONLY table this script writes is
 * `county_facet_coverage` (deployment store), and even that is skipped
 * under `--dry-run`.
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyGeometryScoreCli.ts --county=48261 [--dry-run]
 *   tsx artifacts/api-server/src/countyGeometryScoreCli.ts --all [--dry-run]
 *   tsx artifacts/api-server/src/countyGeometryScoreCli.ts \
 *     --county=48129 --honest-absent='BASIS' --artifact=path/to/evidence.md [--dry-run]
 *
 * DATABASE_URL must point at the ATOMS Postgres (falls back to loading the
 * DATABASE_URL secret via gcloud from GCP_ATOMS_PROJECT, default
 * `hauska-prod-497015`). DEPLOYMENT_DATABASE_URL must point at the
 * DEPLOYMENT Postgres (falls back to loading the DEPLOYMENT_DATABASE_URL
 * secret via gcloud from GCP_PROJECT, default `legacy-design-tools-prod`),
 * identical fallback shape to the sibling CLIs.
 *
 * Exit-bounded: connect both pools -> read atoms counts -> read manifest ->
 * per-county measure+classify+upsert -> summary, then exit. Exit 0 on
 * success, 1 on fatal error.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import {
  classifyFacet,
  type FacetScore,
} from "./lib/countyCoverageClassification";

const { Pool } = pg;

const GEOMETRY_THRESHOLD_PCT = 95;
const GEOMETRY_INSTRUMENT = "countyGeometryScoreCli.ts";

function log(msg: string): void {
  console.log(`[geometry-score] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[geometry-score] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution — TWO independent stores.
// ---------------------------------------------------------------------------

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

/** The ATOMS store (parcel-node lives here). project hauska-prod-497015, database hauska_mcp. */
function resolveAtomsDatabaseUrl(): string {
  return resolveViaGcloud(
    "DATABASE_URL",
    "DATABASE_URL",
    "GCP_ATOMS_PROJECT",
    "hauska-prod-497015",
  );
}

/** The DEPLOYMENT store (county_manifest/county_facet_coverage/txgio_parcel live here). project legacy-design-tools-prod, database neondb. */
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

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/**
 * County FIPS keying for parcel-node atoms.
 * Prefer left(entity_id, 5) — Harris 48201 (and others) may have null
 * body.countyFips. body->>'countyFips' is fallback only.
 * SQL counterpart in readAtomCountsByCounty groups by left(entity_id, 5).
 */
export function countyFipsFromAtomRow(row: {
  entity_id: string;
  body?: { countyFips?: string | null } | null;
}): string | null {
  const fromId = row.entity_id?.match(/^([0-9]{5})/)?.[1] ?? null;
  if (fromId) return fromId;
  const fromBody = row.body?.countyFips?.trim();
  if (fromBody && /^[0-9]{5}$/.test(fromBody)) return fromBody;
  return null;
}

/**
 * parcel-node atom counts by county fips, from the ATOMS store.
 * Key on left(entity_id, 5) (flood scorer pattern). body->>'countyFips'
 * is null for some counties (e.g. Harris 48201); entity_id prefix is the
 * durable county key for parcel-node atoms.
 *
 * When `onlyFips` is set, count that county alone (prefix range on
 * entity_id) — avoids a full 11M-row GROUP BY on single-county applies.
 */
async function readAtomCountsByCounty(
  atomsPool: pg.Pool,
  onlyFips?: string,
): Promise<Map<string, number>> {
  if (onlyFips) {
    const { rows } = await atomsPool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM atoms
        WHERE entity_type = 'parcel-node'
          AND entity_id >= $1
          AND entity_id < $2`,
      [onlyFips, `${onlyFips}\uffff`],
    );
    const out = new Map<string, number>();
    out.set(onlyFips, Number(rows[0]?.n ?? 0));
    return out;
  }
  const { rows } = await atomsPool.query<{ fips: string | null; n: string }>(
    `SELECT left(entity_id, 5) AS fips, count(*) AS n
       FROM atoms
      WHERE entity_type = 'parcel-node'
        AND entity_id ~ '^[0-9]{5}'
      GROUP BY 1`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.fips) continue;
    out.set(r.fips, Number(r.n));
  }
  return out;
}

/** DISTINCT feature_index count for a county from txgio_parcel (falls back to txgio_parcel_staging if the prod table is empty for that fips), from the DEPLOYMENT store. */
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

/** county_manifest target set: fips -> name. Empty map if the table has no rows. */
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

// ---------------------------------------------------------------------------
// Score one county: measure -> classify -> derive rail_state.
// ---------------------------------------------------------------------------

export interface AbsenceDetermination {
  absenceBasis: string;
  verifiedByInstrument: string;
  artifactPath?: string;
  source?: string;
}

export interface GeometryCountyScore {
  fips: string;
  name: string;
  atomCount: number;
  featureCount: number | null;
  featureTable: string | null;
  facet: FacetScore;
  railState: "satisfied-present" | "satisfied-absent" | "not-yet";
  absenceBasis: string | null;
  verifiedByInstrument: string;
  artifactPath: string | null;
}

function isCompleteAbsenceDetermination(
  d: AbsenceDetermination | null | undefined,
): d is AbsenceDetermination {
  return (
    d != null &&
    typeof d.absenceBasis === "string" &&
    d.absenceBasis.trim().length > 0 &&
    typeof d.verifiedByInstrument === "string" &&
    d.verifiedByInstrument.trim().length > 0
  );
}

/**
 * PURE core: given atom count + feature count, produce the facet score +
 * rail_state. No I/O — unit-testable directly. Mirrors `classifyFacet`'s
 * contract from `countyCoverageScoreCli.ts`; the geometry facet has no
 * owner-match oracle (verdict is always `n/a`), matching zoning/envelope.
 *
 * Absence path is FAIL-CLOSED: `satisfied-absent` only when featureCount
 * is null/0 AND caller supplies a complete absenceDetermination
 * (non-null absenceBasis AND verifiedByInstrument). Incomplete or missing
 * evidence yields `not-yet` — never invent absence from a null denominator.
 */
export function scoreGeometry(input: {
  fips: string;
  name: string;
  atomCount: number;
  featureCount: number | null;
  absenceDetermination?: AbsenceDetermination | null;
}): GeometryCountyScore {
  const { fips, name, atomCount, featureCount, absenceDetermination } = input;
  const noFeatures = featureCount == null || featureCount === 0;
  const determinationOk = isCompleteAbsenceDetermination(absenceDetermination);

  if (noFeatures) {
    const facet = classifyFacet({
      facet: "geometry",
      rawCoveragePct: 0,
      sourcePresent: false,
      verdict: null,
      ownerMatchRate: null,
      source: determinationOk
        ? (absenceDetermination.source ?? "honest-absence-determination")
        : null,
      sourceVintage: null,
      sampled: 0,
    });

    if (determinationOk) {
      return {
        fips,
        name,
        atomCount,
        featureCount,
        featureTable: null,
        facet,
        railState: "satisfied-absent",
        absenceBasis: absenceDetermination.absenceBasis.trim(),
        verifiedByInstrument: absenceDetermination.verifiedByInstrument.trim(),
        artifactPath: absenceDetermination.artifactPath?.trim() || null,
      };
    }

    return {
      fips,
      name,
      atomCount,
      featureCount,
      featureTable: null,
      facet,
      railState: "not-yet",
      absenceBasis: null,
      verifiedByInstrument: GEOMETRY_INSTRUMENT,
      artifactPath: null,
    };
  }

  const sourcePresent = true;
  const overcount = atomCount > (featureCount as number);
  const rawCoveragePct = (atomCount / (featureCount as number)) * 100;

  const facet = classifyFacet({
    facet: "geometry",
    rawCoveragePct,
    sourcePresent,
    verdict: null, // no owner oracle for geometry, same as zoning/envelope
    ownerMatchRate: null,
    source: "parcel-node-atom-count",
    sourceVintage: null,
    sampled: 0,
  });

  // Threshold gate: only >=95% writes satisfied-present. Overcount
  // (atomCount > featureCount: duplicates/stale rows) fail-closes to
  // not-yet with the honest unclamped ratio — never Math.min(100,...)
  // shipping satisfied-present (SF-25). Never satisfied-absent from
  // coverage alone.
  const railState: "satisfied-present" | "not-yet" = overcount
    ? "not-yet"
    : facet.honestCoveragePct >= GEOMETRY_THRESHOLD_PCT
      ? "satisfied-present"
      : "not-yet";

  return {
    fips,
    name,
    atomCount,
    featureCount,
    featureTable: null, // filled by caller (I/O-derived, not part of the pure core)
    facet,
    railState,
    absenceBasis: null,
    verifiedByInstrument: GEOMETRY_INSTRUMENT,
    artifactPath: `atoms:entity_type=parcel-node,countyFips=${fips}`,
  };
}

/** Upsert one county's geometry facet row (skipped under dry-run). */
async function upsertLedger(
  deployPool: pg.Pool,
  score: GeometryCountyScore,
): Promise<void> {
  const f = score.facet;
  // absence_basis MUST be written for satisfied-absent (DB CHECK) and MUST
  // clear to NULL on non-absent states so a prior absence does not stick.
  await deployPool.query(
    `INSERT INTO county_facet_coverage
       (county_fips, facet, honest_coverage_pct, integrity_verdict,
        owner_match_rate, source, source_vintage, sampled, classification,
        rail_state, threshold_pct, absence_basis, verification_method,
        verified_by_instrument, artifact_path, checked_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now())
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
       absence_basis          = EXCLUDED.absence_basis,
       verification_method    = EXCLUDED.verification_method,
       verified_by_instrument = EXCLUDED.verified_by_instrument,
       artifact_path          = EXCLUDED.artifact_path,
       checked_at             = now(),
       last_verified_at       = now()`,
    [
      score.fips,
      "geometry",
      f.honestCoveragePct.toFixed(2),
      f.integrityVerdict,
      f.ownerMatchRate != null ? f.ownerMatchRate.toFixed(4) : null,
      f.source,
      f.sourceVintage,
      f.sampled,
      f.classification,
      score.railState,
      GEOMETRY_THRESHOLD_PCT.toFixed(2),
      score.railState === "satisfied-absent" ? score.absenceBasis : null,
      "sweep", // every county in the target set is measured, not sampled
      score.verifiedByInstrument,
      score.artifactPath,
    ],
  );
}

function reportCounty(score: GeometryCountyScore, dryRun: boolean): void {
  const f = score.facet;
  const absenceNote =
    score.railState === "satisfied-absent"
      ? ` absence_basis=${score.absenceBasis ?? "n/a"}`
      : "";
  log(
    `${dryRun ? "DRY-RUN " : ""}${score.fips}/${score.name}: ` +
      `atoms=${score.atomCount} features=${score.featureCount ?? "n/a"} ` +
      `(${score.featureTable ?? "no source table"}) ` +
      `coverage=${f.honestCoveragePct.toFixed(2)}% -> ${f.classification} -> rail_state=${score.railState}${absenceNote}`,
  );
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
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "honest-absent": { type: "string" },
      artifact: { type: "string" },
    },
  });

  const dryRun = values["dry-run"] ?? false;
  const all = values.all ?? false;
  const single = values.county?.trim();
  const honestAbsentBasis = values["honest-absent"]?.trim();
  const artifactPath = values.artifact?.trim();

  if (!all && !single) {
    fail("pass --county=<fips> or --all");
  }
  if (honestAbsentBasis) {
    if (!single || all) {
      fail("--honest-absent requires --county=<fips> (not --all)");
    }
    if (!artifactPath) {
      fail("--honest-absent requires --artifact=<path> (decision/outreach evidence)");
    }
  }

  const startedAt = Date.now();
  const atomsPool = makePool(resolveAtomsDatabaseUrl(), 2);
  const deployPool = makePool(resolveDeploymentDatabaseUrl(), 4);

  let wrote = 0;
  let skippedNoFeatures = 0;
  const scores: GeometryCountyScore[] = [];
  try {
    const manifestCounties = await readManifestCounties(deployPool);
    let targets: string[];
    let atomCounts: Map<string, number>;
    if (all) {
      // Score every county that HAS atoms (the task's "47 counties that
      // have atoms" scope) — scoring a county with zero atoms would only
      // ever write a true-source-gap/not-yet row with coverage 0, which the
      // manifest already renders correctly via no-atom/no-writer fallback
      // for counties that were never atom-written, so it is not useful
      // ledger signal and is skipped to keep `--all` scoped to real work.
      // Honest-absent writes are opt-in via --county + --honest-absent only
      // (fail-closed: never auto-absent under --all).
      atomCounts = await readAtomCountsByCounty(atomsPool);
      log(`atoms store: ${atomCounts.size} counties carry parcel-node atoms`);
      targets = Array.from(atomCounts.keys()).sort();
      log(`--all target set: ${targets.length} counties with parcel-node atoms`);
    } else {
      targets = [single as string];
      atomCounts = await readAtomCountsByCounty(atomsPool, single);
      log(
        `atoms store: county ${single} parcel-node count=${atomCounts.get(single as string) ?? 0}`,
      );
    }

    for (const fips of targets) {
      const atomCount = atomCounts.get(fips) ?? 0;
      const name = manifestCounties.get(fips) ?? fips;
      const featureInfo = await readFeatureCount(deployPool, fips);
      const noDenominator = !featureInfo;

      if (noDenominator && !single && !honestAbsentBasis) {
        // --all path: skip silent (no auto-absent). Explicit --county
        // continues below and scores not-yet or satisfied-absent.
        log(
          `county ${fips}/${name} has ${atomCount} parcel-node atoms but NO txgio_parcel/txgio_parcel_staging rows — skipping (no denominator)`,
        );
        skippedNoFeatures += 1;
        continue;
      }

      if (honestAbsentBasis && !noDenominator) {
        fail(
          `--honest-absent requires featureCount null/0; county ${fips} has ${featureInfo!.features} features in ${featureInfo!.table}`,
        );
      }

      const absenceDetermination: AbsenceDetermination | null =
        honestAbsentBasis && artifactPath
          ? {
              absenceBasis: honestAbsentBasis,
              verifiedByInstrument: GEOMETRY_INSTRUMENT,
              artifactPath,
              source: "honest-absence-determination",
            }
          : null;

      const score = scoreGeometry({
        fips,
        name,
        atomCount,
        featureCount: featureInfo?.features ?? null,
        absenceDetermination,
      });
      score.featureTable = featureInfo?.table ?? null;
      if (absenceDetermination && score.railState === "satisfied-absent") {
        score.artifactPath = artifactPath ?? score.artifactPath;
      }
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
  const satisfiedPresent = scores.filter(
    (s) => s.railState === "satisfied-present",
  ).length;
  const satisfiedAbsent = scores.filter(
    (s) => s.railState === "satisfied-absent",
  ).length;
  const notYet = scores.filter((s) => s.railState === "not-yet").length;
  log("---- geometry-score summary ----");
  log(`mode:                ${dryRun ? "DRY-RUN (no ledger writes)" : "WRITE"}`);
  log(`counties scored:     ${scores.length}`);
  log(`counties skipped:    ${skippedNoFeatures} (no txgio_parcel denominator)`);
  log(`satisfied-present:   ${satisfiedPresent}`);
  log(`satisfied-absent:    ${satisfiedAbsent}`);
  log(`not-yet:             ${notYet}`);
  log(`ledger writes:       ${dryRun ? 0 : wrote}`);
  log(`duration:            ${seconds}s`);
}

/** Entrypoint guard — only run main() when executed directly, not on import. */
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
    console.error("[geometry-score] FATAL:", err);
    process.exit(1);
  });
}
