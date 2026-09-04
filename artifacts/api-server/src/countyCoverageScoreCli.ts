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
 *
 * ZONING AND ENVELOPE RETIRED FROM THIS INSTRUMENT (R1 ruling, 2026-09-04,
 * OPS-19b; see `scoreCounty`'s own comment at the retired call site).
 * `countyRailScoreCli.ts` (lane SS-W15) is now the sole writer of both,
 * scored over a corrected incorporated-city-parcels denominator this CLI
 * never had. The two instruments upserted the same (county_fips, facet)
 * primary key with different denominators — county-wide here, incorporated-
 * only there — so the ledger cell read whichever number ran last: Bastrop
 * alternated between 15.22% and 79.60% depending on which CLI fired most
 * recently. The measurability-refusal machinery (lane SS-W13, 2026-08-19)
 * that used to live here for the zoning stamp moved with it; see
 * `countyRailScoreCli.ts` / `lib/railScoring/countyMeasurability.ts` for the
 * current version of that logic.
 *
 * Classification (see `classifyFacet`):
 *   fabricated-blocked  the join was proven fabricated (owner-match block).
 *   needs-crosswalk     land-use join is thin/insufficient-sample — a real
 *                       source exists but the key needs an external crosswalk.
 *   true-source-gap     the facet has no data because the SOURCE has none
 *                       (e.g. Comal ships no CAD roll) — an honest absence.
 *   real-at-ceiling     the facet is real and at THIS INSTRUMENT'S achievable
 *                       coverage. Read the row's `source`, which names the
 *                       denominator and the instrument's wiring. There is no
 *                       enum value for "measured, below the instrument's own
 *                       reach", so the counting rule carries it. See LEDGER
 *                       PROVENANCE below.
 *
 * FACET KEYS ARE VALIDATED, FAIL-CLOSED. Every key this CLI writes is checked
 * against `lib/db/src/schema/facetKeyRegistry.ts` before any row is upserted.
 * This CLI used to write `land-use` while the rail key is `landuse`; the
 * manifest grid joins `c.facet = r.rail_key`, so 19 production rows joined
 * nothing and no cell ever read them. The CAD-roll join rate is now written
 * under the declared NON-RAIL key `landuse-cad-join`, because it is not the
 * `landuse` rail's subject: the rail is land-use-fact ATOM COUNT and this is
 * roster-to-CAD JOIN FIT. Join quality was ruled not-a-rail on 2026-08-08.
 *
 * LEDGER PROVENANCE. Every row records `verified_by_instrument`,
 * `verification_method` and `artifact_path`, and a `source` that states the
 * counting rule at the point of use (DEV_PROCESS 1.1/1.2). The Travis cell
 * survived four weeks at a wrong 0.00% partly because nothing on the row said
 * who wrote it or what it counted.
 *
 * RAIL_STATE IS NOW DERIVED AND WRITTEN, matching the sibling scorers.
 * `countyFloodScoreCli.ts` and `countyGeometryScoreCli.ts` both write
 * `rail_state` and `threshold_pct` alongside their coverage; this CLI did not,
 * so for the zoning, envelope and land-use facets the NUMBER and the FIELD THE
 * DISPLAY READS had different authors with no consistency constraint between
 * them. That is how Travis 48453 came to hold `rail_state='satisfied-present'`
 * with `honest_coverage_pct=0.00`: a one-off backfill set the display column,
 * this CLI set the number, and nothing reconciled them. Three checked-in
 * scorers, two writing the pair and one writing half of it, is a
 * paired-control divergence between siblings (DEV_PROCESS 2.4).
 *
 * The derivation mirrors `countyGeometryScoreCli.ts`: at or above the rail's
 * declared threshold writes `satisfied-present`; below writes `not-yet` WITH
 * the real coverage, never `satisfied-present` on a number that cannot support
 * it. `satisfied-absent` is deliberately unreachable from here - an absence
 * needs a positive determination and a basis, and a stamp-rate scorer has
 * neither. The diagnostic facet writes a NULL rail_state, because it is not a
 * rail and must never occupy a cell.
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

import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import {
  assertWritableFacetKeys,
  COUNTY_RAIL_DECLARATION,
} from "@workspace/db/schema";
import {
  sampleJoinPairs,
  sampleAddressJoinPairs,
  evaluateJoinIntegrity,
  type QueryablePool,
} from "./lib/joinIntegrityGate";
import { LANDUSE_JOIN_DISABLED_FIPS_SEED } from "./lib/joinNormalize";
/**
 * The classifier moved OUT of this file on 2026-08-19 (lane SS-W18, P-47).
 *
 * `lib/railScoring/engine.ts` imported `classifyFacet` from here, and the
 * `/api/county-ledger` route imports that engine, so THIS CLI was in the
 * server's boot graph. esbuild bundles everything into one `dist/index.mjs`,
 * which makes the `isDirectRun()` guard at the bottom of this file read TRUE
 * at server boot (`import.meta.url` is the bundle, and so is `argv[1]`), so
 * `main()` ran with an empty argv and `process.exit(1)`'d before Express
 * listened. A canary deploy of `5688aa31` failed exactly this way.
 *
 * The pure decisions now live in a leaf module that imports nothing at
 * runtime, and this CLI is a CONSUMER of it like every other scorer. Do not
 * re-export them from here: a re-export would put this file back on the
 * import path that broke production. Enforced by
 * `scripts/checkBootGraphNoCliImports.mjs`.
 */
import {
  classifyFacet,
  type FacetScore,
} from "./lib/countyCoverageClassification";

const { Pool } = pg;

/**
 * County Manifest Sprint 1 (feat/county-manifest-sprint1). `--all` reads
 * its target set from `county_manifest` (254 rows once seeded) instead of
 * a hardcoded map — this retires the same "worked counties only" anti-
 * pattern the ledger audit flagged for this exact constant (doc_repo
 * `_inbox/2026-08-08_LEDGER_schema_audit.md` section 3/6). Falls back to
 * the original ten-county seed ONLY if the manifest is empty (not yet
 * seeded), so `--all` never silently does nothing before the seed SQL
 * from `countyManifestSeedCli.ts` has been applied.
 */
const LEGACY_COUNTY_NAMES_FALLBACK: Record<string, string> = {
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

/** Read the county target set (fips -> name) from county_manifest; empty map if the table does not exist or has no rows yet. */
async function loadManifestCountyNames(
  pool: pg.Pool,
): Promise<Record<string, string>> {
  const exists = await tableExists(pool, "county_manifest");
  if (!exists) return {};
  const r = await pool.query<{ county_fips: string; county_name: string }>(
    "SELECT county_fips, county_name FROM county_manifest ORDER BY county_fips",
  );
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.county_fips] = row.county_name;
  return out;
}

const PARCEL_TABLES = ["txgio_parcel", "txgio_parcel_staging"] as const;

function log(msg: string): void {
  console.log(`[coverage-score] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[coverage-score] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Facet keys, rail thresholds and provenance strings — PURE, unit-testable
// without a DB. The CLASSIFIER itself now lives in
// `lib/countyCoverageClassification.ts`; these stay here because they read
// COUNTY_RAIL_DECLARATION and nothing in the server boot graph wants them.
// ---------------------------------------------------------------------------

/**
 * The DECLARED NON-RAIL key this CLI writes its CAD-roll join rate under.
 *
 * It used to write `land-use`, which the manifest grid could not join to rail
 * `landuse`, so 19 production rows were read by nothing. Renaming it to
 * `landuse` would be worse than the orphan: measured 2026-08-19 on those same
 * 19 counties, the `landuse` rail rows are a DIFFERENT measurement
 * (`land-use-fact-atom-count`, atom coverage) and carry a higher number in all
 * 13 counties currently satisfied, so a merge overwrites a newer measurement
 * with an older, lower, differently-derived one. The key is declared in
 * `lib/db/src/schema/facetKeyRegistry.ts` with the 2026-08-08 ruling that
 * join quality is not a rail.
 */
export const LANDUSE_JOIN_FACET_KEY = "landuse-cad-join";

/** This file, as recorded in `county_facet_coverage.verified_by_instrument`. */
const INSTRUMENT_REF = "countyCoverageScoreCli.ts";

/** Declared threshold for a rail key, or null when the facet is not a rail. */
export function railThresholdPct(facetKey: string): number | null {
  const rail = COUNTY_RAIL_DECLARATION.find((r) => r.railKey === facetKey);
  return rail ? rail.thresholdPct : null;
}

/**
 * Derive the ledger's display state from the measured coverage. PURE.
 *
 * At or above threshold is `satisfied-present`; below threshold is `not-yet`
 * carrying the REAL coverage. `satisfied-absent` is unreachable from here by
 * design. A non-rail facet returns null and occupies no cell.
 */
export function deriveRailState(
  facetKey: string,
  honestCoveragePct: number,
): "satisfied-present" | "not-yet" | null {
  const threshold = railThresholdPct(facetKey);
  if (threshold === null) return null;
  return honestCoveragePct >= threshold ? "satisfied-present" : "not-yet";
}

function landUseArtifactPath(fips: string, table: string): string {
  return `${table}+cad_property;county_fips=${fips};denom=bakeable-parcels`;
}

function stampArtifactPath(fips: string, table: string): string {
  return `${table}.zoning_district;county_fips=${fips};denom=distinct-feature_index`;
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

interface CountyPresence {
  fips: string;
  name: string;
  /** The parcel table this county actually resolved to. */
  table: string;
  parcels: number;
}

/** Which table serves this county (prod winning over staging), plus counts. */
async function locateCounty(
  pool: pg.Pool,
  fips: string,
  countyNames: Record<string, string> = LEGACY_COUNTY_NAMES_FALLBACK,
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
      return {
        fips,
        name: countyNames[fips] ?? LEGACY_COUNTY_NAMES_FALLBACK[fips] ?? fips,
        table,
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
  /**
   * The situs-address RECOVERY coverage: fraction of bakeable parcels that get
   * an OWNER-AGREEING address match (the exact rows the bake would promote via
   * the owner-gated address join). Measured only for prop_id-gate-blocked
   * counties; null otherwise. This is the honest coverage the ledger records
   * for a blocked county whose land-use is recovered via address, replacing the
   * dead-prop_id-join 0.
   */
  landUseAddressRecoveredPct: number | null;
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
  measureAddressRecovery: boolean,
): Promise<RawCoverage> {
  const { fips, table, parcels } = county;

  const cadPresent = await tableExists(pool, "cad_property");
  let cadCountyRows = 0;
  let landUseVintage: string | null = null;
  const declared = tryResolveDeclaredCadVintage(fips);
  if (cadPresent && declared) {
    // CAD_PROPERTY_MULTI_YEAR_INVENTORY — intentional; not a single-vintage derivation
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
  if (landUseSourcePresent && declared) {
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
         SELECT prop_id AS join_key
           FROM cad_property
          WHERE county_fips = $1
            AND tax_year = $2
            AND property_use_code IS NOT NULL
       )
       SELECT
         count(*) FILTER (WHERE c.join_key IS NOT NULL) AS matched,
         count(*) AS total
       FROM parcels p
       LEFT JOIN cad c ON c.join_key = p.join_key`,
      [declared.countyFips, declared.taxYear],
    );
    const matched = Number(r.rows[0]?.matched ?? 0);
    const total = Number(r.rows[0]?.total ?? 0);
    landUseRawPct = total > 0 ? (matched / total) * 100 : 0;
  }

  // --- situs-ADDRESS recovery coverage (owner-gated) ---
  // For a prop_id-gate-blocked county the recovered coverage is the fraction of
  // bakeable parcels that get an OWNER-AGREEING address match — exactly the rows
  // the owner-gated address join promotes. The owner-agreement rule below
  // mirrors `ownersAgree`: leading-token equality after upper + punctuation-to-
  // space + first-comma reorder (surname-leading) + noise-token drop, with a
  // >=4 shared-prefix allowance. Kept in SQL so the measured rate is the same
  // join the bake runs. Owner names are read for the gate ONLY (aggregate rate);
  // no owner leaves this measurement.
  let landUseAddressRecoveredPct: number | null = null;
  if (measureAddressRecovery && landUseSourcePresent && declared) {
    const ADDR_NORM = (col: string): string =>
      `upper(regexp_replace(${col}, '[^A-Za-z0-9]', '', 'g'))`;
    // Leading owner token, in SQL: reorder "LAST, FIRST" so surname leads, map
    // non-alphanumerics to spaces, drop the noise tokens the gate drops, take
    // the first remaining token. NULL when no usable token (uninformative).
    const OWNER_LEAD = (col: string): string => `(
      SELECT t FROM (
        SELECT unnest(
          string_to_array(
            btrim(regexp_replace(
              upper(
                CASE WHEN position(',' in ${col}) > 0
                  THEN substring(${col} from 1 for position(',' in ${col}) - 1)
                       || ' ' ||
                       substring(${col} from position(',' in ${col}) + 1)
                  ELSE ${col} END
              ),
              '[^A-Z0-9]+', ' ', 'g'
            )),
            ' '
          )
        ) AS t
      ) toks
      WHERE t <> '' AND t NOT IN (
        'JR','SR','II','III','IV','V','LLC','LP','LLP','LTD','INC','CORP','CO',
        'COMPANY','TRUST','TR','ESTATE','EST','ET','AL','ETAL','ETUX','ETVIR','THE'
      )
      LIMIT 1
    )`;
    const r = await pool.query<{ accepted: string; total: string }>(
      `WITH parcels AS (
         SELECT DISTINCT ON (feature_index)
                feature_index,
                ${ADDR_NORM("situs_address")} AS addr_key,
                ${OWNER_LEAD("owner_name")} AS owner_lead
           FROM ${table}
          WHERE county_fips = $1
            AND situs_address IS NOT NULL AND situs_address <> ''
          ORDER BY feature_index
       ),
       cad AS (
         SELECT DISTINCT ON (${ADDR_NORM("situs_address")})
                ${ADDR_NORM("situs_address")} AS addr_key,
                ${OWNER_LEAD("owner_name")} AS owner_lead
           FROM cad_property
          WHERE county_fips = $1
            AND tax_year = $2
            AND property_use_code IS NOT NULL
            AND situs_address IS NOT NULL AND situs_address <> ''
          ORDER BY ${ADDR_NORM("situs_address")}, prop_id
       )
       SELECT
         count(*) FILTER (
           WHERE c.addr_key IS NOT NULL
             AND p.owner_lead IS NOT NULL AND c.owner_lead IS NOT NULL
             AND (
               p.owner_lead = c.owner_lead
               OR (length(least(p.owner_lead, c.owner_lead)) >= 4
                   AND greatest(p.owner_lead, c.owner_lead)
                       LIKE least(p.owner_lead, c.owner_lead) || '%')
             )
         ) AS accepted,
         count(*) AS total
       FROM parcels p
       LEFT JOIN cad c ON c.addr_key = p.addr_key AND p.addr_key <> ''`,
      [declared.countyFips, declared.taxYear],
    );
    const accepted = Number(r.rows[0]?.accepted ?? 0);
    const total = Number(r.rows[0]?.total ?? 0);
    landUseAddressRecoveredPct = total > 0 ? (accepted / total) * 100 : 0;
  }

  return {
    parcels,
    landUseRawPct,
    landUseSourcePresent,
    landUseVintage,
    landUseAddressRecoveredPct,
  };
}

// ---------------------------------------------------------------------------
// Per-county score: measure -> gate -> classify -> (upsert).
// ---------------------------------------------------------------------------

export interface RefusedFacet {
  facet: string;
  refusal: string;
  basis: string;
}

export interface CountyScore {
  fips: string;
  name: string;
  parcels: number;
  facets: FacetScore[];
  /**
   * Facets this instrument could not measure. NEVER collapsed into a 0% row:
   * a refusal and a measured zero are different facts and the ledger must not
   * render them identically.
   */
  refused: RefusedFacet[];
}

async function scoreCounty(
  pool: pg.Pool,
  county: CountyPresence,
): Promise<CountyScore> {
  // The prop_id gate must run BEFORE coverage measurement so we know whether to
  // also measure the address-recovery coverage. A county is treated as
  // prop_id-blocked when the fresh gate verdict is `block` OR it is in the
  // permanent seed floor (Williamson/Hays), matching the effective block set
  // the bakes act on.
  const cadPresent = await tableExists(pool, "cad_property");
  const propIdSample = cadPresent
    ? await sampleJoinPairs(pool as unknown as QueryablePool, county.fips, 2000)
    : [];
  const propIdGate = evaluateJoinIntegrity({
    county: county.fips,
    facet: "land-use",
    sample: propIdSample,
  });
  const propIdBlocked =
    propIdGate.verdict === "block" ||
    LANDUSE_JOIN_DISABLED_FIPS_SEED.has(county.fips);

  const cov = await measureCoverage(pool, county, propIdBlocked);

  // --- LAND-USE classification ---
  // A prop_id-blocked county recovers land-use via the owner-gated situs-address
  // join, so the ledger must reflect the ADDRESS join's owner-match + recovered
  // coverage (the effective join the bake uses), not the dead prop_id join's 0.
  // A non-blocked county classifies on the normal prop_id join, unchanged.
  let landUse: FacetScore;
  if (propIdBlocked && cov.landUseSourcePresent) {
    const addrSample = await sampleAddressJoinPairs(
      pool as unknown as QueryablePool,
      county.fips,
      2000,
    );
    const addrGate = evaluateJoinIntegrity({
      county: county.fips,
      facet: "land-use",
      sample: addrSample,
    });
    // Classify on the ADDRESS join. When it passes, the recovered coverage is
    // the owner-agreeing address-match rate (the rows the bake promotes); its
    // owner-match is the address gate's rate; its source is the address join.
    landUse = classifyFacet({
      facet: LANDUSE_JOIN_FACET_KEY,
      rawCoveragePct: cov.landUseAddressRecoveredPct ?? 0,
      sourcePresent: cov.landUseSourcePresent,
      verdict: addrGate.verdict,
      ownerMatchRate: addrGate.ownerMatchRate,
      source: "cad-roll-address-join",
      sourceVintage: cov.landUseVintage,
      sampled: addrGate.sampled,
    });
  } else {
    landUse = classifyFacet({
      facet: LANDUSE_JOIN_FACET_KEY,
      rawCoveragePct: cov.landUseRawPct,
      sourcePresent: cov.landUseSourcePresent,
      verdict: propIdGate.verdict,
      ownerMatchRate: cov.landUseSourcePresent ? propIdGate.ownerMatchRate : null,
      source: cov.landUseSourcePresent ? "cad-roll" : null,
      sourceVintage: cov.landUseVintage,
      sampled: propIdGate.sampled,
    });
  }

  // ZONING + ENVELOPE RETIRED FROM THIS INSTRUMENT (R1 ruling, 2026-09-04,
  // OPS-19b). `countyRailScoreCli.ts` (lane SS-W15) is now the sole writer of
  // both facets over the corrected incorporated-city-parcels denominator.
  // This CLI and that one both upserted the same (county_fips, facet) primary
  // key with DIFFERENT denominators (this one over every county parcel,
  // that one over incorporated parcels only) -- last-run-wins, so Bastrop's
  // zoning cell alternated between 15.22% and 79.60% depending on which ran
  // most recently. SS-W15's own PR named the fix and correctly declined to
  // execute a retirement in a different lane's file without a ruling; this is
  // that ruling, executed. `refused` stays declared on `CountyScore` (kept
  // for whichever facet this instrument still measures and might refuse) but
  // is always empty for zoning/envelope now: this instrument no longer
  // attempts them at all, which is a different fact from attempting and being
  // refused. See `countyCoverageScoreCli.zoningEnvelopeRetirement.test.ts`
  // for the regression guard.
  const facets: FacetScore[] = [landUse];
  const refused: RefusedFacet[] = [];

  return {
    fips: county.fips,
    name: county.name,
    parcels: cov.parcels,
    facets,
    refused,
  };
}

/**
 * Upsert one county's facet rows into the ledger (skipped under dry-run).
 *
 * FAIL-CLOSED on the facet key. `assertWritableFacetKeys` throws before the
 * first statement if any key is neither a rail key nor a declared diagnostic
 * key, or if it merely COLLAPSES onto a rail key once hyphens and case are
 * normalised. The second half is the part that matters: `land-use` versus
 * `landuse` is a near miss, and no equality check between two key sets can
 * see it. Registry: `lib/db/src/schema/facetKeyRegistry.ts`.
 */
async function upsertLedger(
  pool: pg.Pool,
  score: CountyScore,
  table: string,
): Promise<void> {
  assertWritableFacetKeys(score.facets.map((f) => f.facet));
  for (const f of score.facets) {
    const artifactPath =
      f.facet === LANDUSE_JOIN_FACET_KEY
        ? landUseArtifactPath(score.fips, table)
        : stampArtifactPath(score.fips, table);
    const threshold = railThresholdPct(f.facet);
    const railState = deriveRailState(f.facet, f.honestCoveragePct);
    await pool.query(
      `INSERT INTO county_facet_coverage
         (county_fips, facet, honest_coverage_pct, integrity_verdict,
          owner_match_rate, source, source_vintage, sampled, classification,
          checked_at, verified_by_instrument, verification_method,
          artifact_path, last_verified_at, rail_state, threshold_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, now(),
               $13, $14)
       ON CONFLICT (county_fips, facet) DO UPDATE SET
         honest_coverage_pct    = EXCLUDED.honest_coverage_pct,
         integrity_verdict      = EXCLUDED.integrity_verdict,
         owner_match_rate       = EXCLUDED.owner_match_rate,
         source                 = EXCLUDED.source,
         source_vintage         = EXCLUDED.source_vintage,
         sampled                = EXCLUDED.sampled,
         classification         = EXCLUDED.classification,
         checked_at             = now(),
         verified_by_instrument = EXCLUDED.verified_by_instrument,
         verification_method    = EXCLUDED.verification_method,
         artifact_path          = EXCLUDED.artifact_path,
         last_verified_at       = now(),
         rail_state             = EXCLUDED.rail_state,
         threshold_pct          = EXCLUDED.threshold_pct`,
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
        INSTRUMENT_REF,
        // A full-table aggregate over every parcel in the county, not a
        // sample. The owner-match rate inside the land-use facet IS sampled,
        // and that sample size rides its own `sampled` column.
        "sweep",
        artifactPath,
        railState,
        threshold != null ? threshold.toFixed(2) : null,
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
    const railState = deriveRailState(f.facet, f.honestCoveragePct);
    log(
      `  ${f.facet.padEnd(16)} coverage=${f.honestCoveragePct
        .toFixed(1)
        .padStart(5)}%  verdict=${f.integrityVerdict.padEnd(19)} ` +
        `owner-match=${omr.padStart(6)}  -> ${f.classification}` +
        `  rail_state=${railState ?? "n/a non-rail"}`,
    );
  }
  // A refusal is printed as loudly as a measurement. A silent skip is the
  // defect class this programme hunts; the whole point of refusing is that
  // somebody sees it.
  for (const r of score.refused) {
    log(`  ${r.facet.padEnd(16)} NOT MEASURED (${r.refusal}) — ${r.basis}`);
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
  let facetRowsWritten = 0;
  const refusalCounts = new Map<string, number>();
  let targets: string[] = [];
  try {
    // County Manifest Sprint 1. `--all` reads its target set from
    // county_manifest (254 rows once seeded) instead of the retired
    // COUNTY_NAMES hardcoded map — falls back to the legacy ten-county
    // seed only if the manifest has not been seeded yet (empty table),
    // so `--all` never silently scores zero counties before the seed SQL
    // from countyManifestSeedCli.ts has been applied.
    const manifestCountyNames = await loadManifestCountyNames(pool);
    const countyNames =
      Object.keys(manifestCountyNames).length > 0
        ? manifestCountyNames
        : LEGACY_COUNTY_NAMES_FALLBACK;
    if (all) {
      targets = Object.keys(countyNames);
      log(
        `--all target set: ${targets.length} counties from ${
          Object.keys(manifestCountyNames).length > 0
            ? "county_manifest"
            : "legacy fallback (county_manifest not yet seeded)"
        }`,
      );
    } else {
      targets = [single as string];
    }

    for (const fips of targets) {
      const county = await locateCounty(pool, fips, countyNames);
      if (!county) {
        log(`county ${fips} has no parcels in either table — skipping`);
        skipped += 1;
        continue;
      }
      const score = await scoreCounty(pool, county);
      reportCounty(score, dryRun);
      for (const r of score.refused) {
        refusalCounts.set(r.refusal, (refusalCounts.get(r.refusal) ?? 0) + 1);
      }
      if (!dryRun) {
        await upsertLedger(pool, score, county.table);
        wrote += 1;
        facetRowsWritten += score.facets.length;
      }
    }
  } finally {
    await pool.end();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const refusalTotal = [...refusalCounts.values()].reduce((a, b) => a + b, 0);
  log("---- coverage-score summary ----");
  log(`mode:             ${dryRun ? "DRY-RUN (no ledger writes)" : "WRITE"}`);
  log(`counties scored:  ${targets.length - skipped}`);
  log(`counties skipped: ${skipped} (no parcels in either table)`);
  log(
    `ledger rows:      ${dryRun ? 0 : facetRowsWritten} across ${
      dryRun ? 0 : wrote
    } counties`,
  );
  // Refusals are a REPORTED CLASS, never a subtraction from the scored count
  // (DEV_PROCESS 1.3). Each is a facet this instrument could not see, and the
  // count is per facet-cell, not per county.
  log(`facet cells NOT MEASURED: ${refusalTotal}`);
  for (const [refusal, n] of [...refusalCounts.entries()].sort()) {
    log(`  ${refusal.padEnd(18)} ${n}`);
  }
  log(`duration:         ${seconds}s`);
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
