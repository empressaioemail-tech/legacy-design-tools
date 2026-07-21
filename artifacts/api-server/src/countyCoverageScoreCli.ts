#!/usr/bin/env node
/**
 * Per-county coverage + correctness SCORER CLI.
 *
 * Computes the HONEST per-facet coverage for a county, runs the owner-match
 * integrity gate on the land-use join, CLASSIFIES each facet, and UPSERTS one
 * `county_facet_coverage` ledger row per facet. This is the Stage-4 LEDGER
 * writer of the provable county-data pipeline: "county done" = gates passed +
 * ledger rows written.
 *
 * READ-ONLY on the parcel/CAD data. The ONLY table it writes is the ledger
 * (`county_facet_coverage`), and even that is skipped under `--dry-run`.
 *
 * Facets scored per county:
 *   - land-use   — join rate (bakeable parcels with a cad land-use match /
 *                  bakeable parcels), GATED by the owner-match integrity gate:
 *                  a BLOCKED join records honest_coverage 0 (never the
 *                  fabricated stamp rate) and verdict 'block'.
 *   - zoning     — stamped % (parcels with a non-null zoning_district /
 *                  parcels). No owner oracle -> verdict 'n/a'.
 *   - envelope   — derivable % proxy: parcels that carry BOTH a zoning
 *                  district AND geometry (the deterministic Tier-1 envelope's
 *                  precondition). No owner oracle -> verdict 'n/a'.
 *
 * Classification (see `classifyFacet`):
 *   fabricated-blocked  the join was proven fabricated (owner-match block).
 *   needs-crosswalk     land-use join is thin/insufficient-sample — a real
 *                       source exists but the key needs an external crosswalk.
 *   true-source-gap     the facet has no data because the SOURCE has none
 *                       (e.g. Comal ships no CAD roll) — an honest absence.
 *   real-at-ceiling     the facet is real and at its achievable coverage.
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyCoverageScoreCli.ts --county=48491 [--dry-run]
 *   tsx artifacts/api-server/src/countyCoverageScoreCli.ts --all [--dry-run]
 *
 * DATABASE_URL must point at the parcel Postgres (falls back to loading the
 * DEPLOYMENT_DATABASE_URL secret via gcloud, mirroring the bake CLIs).
 *
 * Exit-bounded: connect -> per-county read+score+upsert -> summary, then exit.
 * Exit 0 on success, 1 on fatal error.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import {
  sampleJoinPairs,
  evaluateJoinIntegrity,
  type JoinIntegrityReport,
  type QueryablePool,
} from "./lib/joinIntegrityGate";

const { Pool } = pg;

/** The ten Central-TX counties (same registry the bakes use). */
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
  console.log(`[coverage-score] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[coverage-score] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Classification — PURE, unit-testable without a DB.
// ---------------------------------------------------------------------------

export type Classification =
  | "real-at-ceiling"
  | "needs-crosswalk"
  | "true-source-gap"
  | "fabricated-blocked";

export interface FacetScore {
  facet: string;
  /** HONEST coverage 0..100 (a blocked land-use facet records 0). */
  honestCoveragePct: number;
  /** The integrity verdict; 'n/a' for facets with no owner oracle. */
  integrityVerdict: JoinIntegrityReport["verdict"] | "n/a";
  /** 0..1 owner-match rate, or null for n/a facets. */
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  sampled: number;
  classification: Classification;
}

export interface ClassifyInput {
  facet: string;
  /**
   * RAW coverage the join produced BEFORE gating, 0..100 — for land-use this
   * is the fabricated-or-real stamp rate; the classifier zeroes it when
   * blocked.
   */
  rawCoveragePct: number;
  /** Whether the SOURCE exists at all (e.g. a CAD roll is loaded). */
  sourcePresent: boolean;
  /** The gate verdict for facets with an owner oracle; null for n/a facets. */
  verdict: JoinIntegrityReport["verdict"] | null;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  sampled: number;
}

/**
 * Classify a facet from its raw coverage + gate verdict + source presence.
 * PURE. This is the load-bearing decision the ledger records, so it is
 * separated from all I/O and unit-tested directly.
 *
 * Rules (in priority order):
 *  1. verdict 'block'                -> fabricated-blocked, honest coverage 0.
 *     (A proven fabrication is stored as honest-absence, never the stamp rate.)
 *  2. no source at all               -> true-source-gap, coverage 0.
 *     (Comal ships no CAD roll; the gap is the source's, honestly reported.)
 *  3. verdict 'insufficient-sample'
 *     AND some raw coverage          -> needs-crosswalk.
 *     (A source exists but the join key is too thin to prove — an external
 *     CAD-account⟷prop_id crosswalk is the unblock.)
 *  4. otherwise                      -> real-at-ceiling, honest = raw.
 */
export function classifyFacet(input: ClassifyInput): FacetScore {
  const {
    facet,
    rawCoveragePct,
    sourcePresent,
    verdict,
    ownerMatchRate,
    source,
    sourceVintage,
    sampled,
  } = input;

  let classification: Classification;
  let honestCoveragePct: number;

  if (verdict === "block") {
    classification = "fabricated-blocked";
    honestCoveragePct = 0;
  } else if (!sourcePresent) {
    classification = "true-source-gap";
    honestCoveragePct = 0;
  } else if (verdict === "insufficient-sample" && rawCoveragePct > 0) {
    classification = "needs-crosswalk";
    // The raw coverage is not proven real, so it is not asserted as honest
    // coverage; the crosswalk lifts it later. Record 0 honest until proven.
    honestCoveragePct = 0;
  } else {
    classification = "real-at-ceiling";
    honestCoveragePct = rawCoveragePct;
  }

  return {
    facet,
    honestCoveragePct,
    integrityVerdict: verdict ?? "n/a",
    ownerMatchRate,
    source,
    sourceVintage,
    sampled,
    classification,
  };
}

// ---------------------------------------------------------------------------
// DATABASE_URL resolution (identical fallback to the bake CLIs).
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
// Read-only coverage measurement.
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

interface CountyPresence {
  fips: string;
  name: string;
  table: string;
  hasZoning: boolean;
  parcels: number;
}

/** Which table serves this county (prod winning over staging), plus counts. */
async function locateCounty(
  pool: pg.Pool,
  fips: string,
): Promise<CountyPresence | null> {
  for (const table of PARCEL_TABLES) {
    if (!(await tableExists(pool, table))) continue;
    const r = await pool.query<{ parcels: string }>(
      `SELECT count(DISTINCT feature_index) AS parcels
         FROM ${table}
        WHERE county_fips = $1`,
      [fips],
    );
    const parcels = Number(r.rows[0]?.parcels ?? 0);
    if (parcels > 0) {
      const hasZoning = await columnExists(pool, table, "zoning_district");
      return {
        fips,
        name: COUNTY_NAMES[fips] ?? fips,
        table,
        hasZoning,
        parcels,
      };
    }
  }
  return null;
}

interface RawCoverage {
  parcels: number;
  landUseRawPct: number;
  landUseSourcePresent: boolean;
  landUseVintage: string | null;
  zoningStampedPct: number;
  envelopeDerivablePct: number;
}

/**
 * Measure raw coverage for a county with READ-ONLY aggregate queries.
 *
 * land-use RAW %: the same join the bake performs (normalized key), counted as
 * DISTINCT bakeable parcels with a cad match / DISTINCT bakeable parcels. This
 * is the pre-gate number; the gate + classifier decide whether it is honest or
 * fabricated. The NORMALIZE_SQL mirrors `normalizeForJoin`.
 */
async function measureCoverage(
  pool: pg.Pool,
  county: CountyPresence,
): Promise<RawCoverage> {
  const { fips, table, hasZoning, parcels } = county;

  const cadPresent = await tableExists(pool, "cad_property");
  let cadCountyRows = 0;
  let landUseVintage: string | null = null;
  if (cadPresent) {
    const r = await pool.query<{ n: string; vintage: string | null }>(
      `SELECT count(*) AS n, max(source_vintage) AS vintage
         FROM cad_property
        WHERE county_fips = $1 AND property_use_code IS NOT NULL`,
      [fips],
    );
    cadCountyRows = Number(r.rows[0]?.n ?? 0);
    landUseVintage = r.rows[0]?.vintage ?? null;
  }
  const landUseSourcePresent = cadPresent && cadCountyRows > 0;

  // --- land-use RAW join rate (bake's normalized key) ---
  // Mirrors the post-#313 `normalizeForJoin`: trim + leading-zero strip on an
  // all-digits value; a non-numeric id (un-stripped R-account, junk) is left
  // as-is and does not match a bare-numeric cad key.
  const NORMALIZE_SQL = `
    CASE
      WHEN trim(prop_id) ~ '^[0-9]+$'
        THEN regexp_replace(trim(prop_id), '^0+([0-9])', '\\1')
      ELSE trim(prop_id)
    END`;
  let landUseRawPct = 0;
  if (landUseSourcePresent) {
    const r = await pool.query<{ matched: string; total: string }>(
      `WITH parcels AS (
         SELECT DISTINCT ON (feature_index)
                feature_index,
                ${NORMALIZE_SQL} AS join_key
           FROM ${table}
          WHERE county_fips = $1 AND prop_id IS NOT NULL
          ORDER BY feature_index
       ),
       cad AS (
         SELECT DISTINCT ON (prop_id) prop_id AS join_key
           FROM cad_property
          WHERE county_fips = $1 AND property_use_code IS NOT NULL
          ORDER BY prop_id, tax_year DESC
       )
       SELECT
         count(*) FILTER (WHERE c.join_key IS NOT NULL) AS matched,
         count(*) AS total
       FROM parcels p
       LEFT JOIN cad c ON c.join_key = p.join_key`,
      [fips],
    );
    const matched = Number(r.rows[0]?.matched ?? 0);
    const total = Number(r.rows[0]?.total ?? 0);
    landUseRawPct = total > 0 ? (matched / total) * 100 : 0;
  }

  // --- zoning stamped % ---
  let zoningStampedPct = 0;
  if (hasZoning) {
    const r = await pool.query<{ stamped: string; total: string }>(
      `WITH d AS (
         SELECT DISTINCT ON (feature_index) feature_index, zoning_district
           FROM ${table}
          WHERE county_fips = $1
          ORDER BY feature_index
       )
       SELECT
         count(*) FILTER (WHERE zoning_district IS NOT NULL) AS stamped,
         count(*) AS total
       FROM d`,
      [fips],
    );
    const stamped = Number(r.rows[0]?.stamped ?? 0);
    const total = Number(r.rows[0]?.total ?? 0);
    zoningStampedPct = total > 0 ? (stamped / total) * 100 : 0;
  }

  // --- envelope derivable % (zoning present AND geometry present) ---
  let envelopeDerivablePct = 0;
  {
    const zoningExpr = hasZoning
      ? "zoning_district IS NOT NULL"
      : "false"; // no zoning column -> no deterministic envelope precondition
    const r = await pool.query<{ derivable: string; total: string }>(
      `WITH d AS (
         SELECT DISTINCT ON (feature_index) feature_index,
                ${hasZoning ? "zoning_district" : "NULL::text AS zoning_district"},
                geometry
           FROM ${table}
          WHERE county_fips = $1
          ORDER BY feature_index
       )
       SELECT
         count(*) FILTER (WHERE ${zoningExpr} AND geometry IS NOT NULL) AS derivable,
         count(*) AS total
       FROM d`,
      [fips],
    );
    const derivable = Number(r.rows[0]?.derivable ?? 0);
    const total = Number(r.rows[0]?.total ?? 0);
    envelopeDerivablePct = total > 0 ? (derivable / total) * 100 : 0;
  }

  return {
    parcels,
    landUseRawPct,
    landUseSourcePresent,
    landUseVintage,
    zoningStampedPct,
    envelopeDerivablePct,
  };
}

// ---------------------------------------------------------------------------
// Per-county score: measure -> gate -> classify -> (upsert).
// ---------------------------------------------------------------------------

export interface CountyScore {
  fips: string;
  name: string;
  parcels: number;
  facets: FacetScore[];
}

async function scoreCounty(
  pool: pg.Pool,
  county: CountyPresence,
): Promise<CountyScore> {
  const cov = await measureCoverage(pool, county);

  // Owner-match gate on the land-use join (only meaningful when a source
  // exists; with no roll the sample is empty -> insufficient-sample, and the
  // classifier routes that to true-source-gap via sourcePresent=false).
  const sample = cov.landUseSourcePresent
    ? await sampleJoinPairs(pool as unknown as QueryablePool, county.fips, 2000)
    : [];
  const gate = evaluateJoinIntegrity({
    county: county.fips,
    facet: "land-use",
    sample,
  });

  const landUse = classifyFacet({
    facet: "land-use",
    rawCoveragePct: cov.landUseRawPct,
    sourcePresent: cov.landUseSourcePresent,
    verdict: gate.verdict,
    ownerMatchRate: cov.landUseSourcePresent ? gate.ownerMatchRate : null,
    source: cov.landUseSourcePresent ? "cad-roll" : null,
    sourceVintage: cov.landUseVintage,
    sampled: gate.sampled,
  });

  const zoning = classifyFacet({
    facet: "zoning",
    rawCoveragePct: cov.zoningStampedPct,
    sourcePresent: cov.zoningStampedPct > 0,
    verdict: null, // no owner oracle for zoning
    ownerMatchRate: null,
    source: cov.zoningStampedPct > 0 ? "zoning-stamp" : null,
    sourceVintage: null,
    sampled: 0,
  });

  const envelope = classifyFacet({
    facet: "envelope",
    rawCoveragePct: cov.envelopeDerivablePct,
    sourcePresent: cov.envelopeDerivablePct > 0,
    verdict: null, // deterministic; no owner oracle
    ownerMatchRate: null,
    source: cov.envelopeDerivablePct > 0 ? "deterministic" : null,
    sourceVintage: null,
    sampled: 0,
  });

  return {
    fips: county.fips,
    name: county.name,
    parcels: cov.parcels,
    facets: [landUse, zoning, envelope],
  };
}

/** Upsert one county's facet rows into the ledger (skipped under dry-run). */
async function upsertLedger(
  pool: pg.Pool,
  score: CountyScore,
): Promise<void> {
  for (const f of score.facets) {
    await pool.query(
      `INSERT INTO county_facet_coverage
         (county_fips, facet, honest_coverage_pct, integrity_verdict,
          owner_match_rate, source, source_vintage, sampled, classification,
          checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (county_fips, facet) DO UPDATE SET
         honest_coverage_pct = EXCLUDED.honest_coverage_pct,
         integrity_verdict   = EXCLUDED.integrity_verdict,
         owner_match_rate    = EXCLUDED.owner_match_rate,
         source              = EXCLUDED.source,
         source_vintage      = EXCLUDED.source_vintage,
         sampled             = EXCLUDED.sampled,
         classification      = EXCLUDED.classification,
         checked_at          = now()`,
      [
        score.fips,
        f.facet,
        f.honestCoveragePct.toFixed(2),
        f.integrityVerdict,
        f.ownerMatchRate != null ? f.ownerMatchRate.toFixed(4) : null,
        f.source,
        f.sourceVintage,
        f.sampled,
        f.classification,
      ],
    );
  }
}

function reportCounty(score: CountyScore, dryRun: boolean): void {
  log(
    `${dryRun ? "DRY-RUN " : ""}${score.fips}/${score.name} ` +
      `(${score.parcels} parcels):`,
  );
  for (const f of score.facets) {
    const omr =
      f.ownerMatchRate != null
        ? `${(f.ownerMatchRate * 100).toFixed(1)}%`
        : "n/a";
    log(
      `  ${f.facet.padEnd(9)} coverage=${f.honestCoveragePct
        .toFixed(1)
        .padStart(5)}%  verdict=${f.integrityVerdict.padEnd(19)} ` +
        `owner-match=${omr.padStart(6)}  -> ${f.classification}`,
    );
  }
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
    },
  });

  const dryRun = values["dry-run"] ?? false;
  const all = values.all ?? false;
  const single = values.county?.trim();

  if (!all && !single) {
    fail("pass --county=<fips> or --all");
  }

  const targets = all ? Object.keys(COUNTY_NAMES) : [single as string];

  const startedAt = Date.now();
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
    max: 4,
  });

  let wrote = 0;
  let skipped = 0;
  try {
    for (const fips of targets) {
      const county = await locateCounty(pool, fips);
      if (!county) {
        log(`county ${fips} has no parcels in either table — skipping`);
        skipped += 1;
        continue;
      }
      const score = await scoreCounty(pool, county);
      reportCounty(score, dryRun);
      if (!dryRun) {
        await upsertLedger(pool, score);
        wrote += 1;
      }
    }
  } finally {
    await pool.end();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- coverage-score summary ----");
  log(`mode:            ${dryRun ? "DRY-RUN (no ledger writes)" : "WRITE"}`);
  log(`counties scored: ${targets.length - skipped}`);
  log(`counties skipped:${skipped}`);
  log(`ledger writes:   ${dryRun ? 0 : wrote} (x3 facets each)`);
  log(`duration:        ${seconds}s`);
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
    console.error("[coverage-score] FATAL:", err);
    process.exit(1);
  });
}
