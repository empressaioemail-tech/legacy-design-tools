#!/usr/bin/env node
/**
 * County Manifest Sprint 1 SEED-GENERATOR CLI.
 *
 * Reads `artifacts/api-server/data/texas_county_roster_v1.json` (a
 * counties-only extract of doc_repo's `_catalog/texas_roster_v1.json`,
 * checked into this repo so this script has no cross-repo dependency —
 * see doc_repo `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` open
 * question 3) and EMITS a SQL artifact. It does NOT connect to a
 * database and does NOT execute anything. This is deliberate: Sprint 1
 * authorization is "write a migration FILE" and "NO database writes of
 * any kind" — this script is the artifact-producing half of the seed
 * step from the spec's build order (section 9, steps 4 + 6); running the
 * emitted SQL against a target Postgres is a separate, explicitly
 * authorized step.
 *
 * Emits two statement groups, per the spec's section 7 seeding plan:
 *
 *  1. `county_manifest` — 254 INSERT rows, one per roster county. Every
 *     column on the table has a direct, unconditional source in the
 *     roster (spec section 1 table), so all 254 rows are honestly
 *     seedable today. `ON CONFLICT (county_fips) DO UPDATE` so re-running
 *     this generator against a refreshed roster snapshot is idempotent
 *     and always reflects the latest roster load (the manifest is a
 *     load, not a live sync — every re-seed is a new roster snapshot).
 *
 *  2. `county_facet_coverage` zoning cells — 254 `not-yet` rows, ONE PER
 *     COUNTY, from `zoning_regime.doctrine` on every unincorporated-county
 *     roster row. This is the ONLY rail the roster can honestly pre-seed
 *     without a live scorer run (spec section 7): `cad` has no atom
 *     family (renders no-atom regardless); `envelope` has no unconditional
 *     roster field; `landuse`/`footprint`/`easement` are all gated on
 *     atom-family state the roster does not carry. This is a COUNTY-LEVEL
 *     UNINCORPORATED-ABSENCE finding only — it does NOT cover incorporated
 *     cities, which are a separate, unseeded question (spec section 8,
 *     deferred). Seeded as `not-yet`, NOT `satisfied-absent` (fixed
 *     2026-08-08, fix/manifest-doctrine-honesty): a county-wide zoning
 *     rail cannot be scored SATISFIED off a finding that only speaks to
 *     unincorporated territory — the original satisfied-absent seeding let
 *     one repeated doctrine string drive 99.2 percent of the reported
 *     Texas completeness percentage from a definition, not a measurement.
 *     The doctrine citation survives in `absence_basis`, scope-qualified,
 *     so it is not erased, only correctly excluded from the completeness
 *     rollup. `ON CONFLICT (county_fips, facet) DO NOTHING` so this NEVER
 *     overwrites a scorer-written row (the live 19-county real zoning
 *     scores from countyCoverageScoreCli must survive untouched).
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyManifestSeedCli.ts [--out=<path>]
 *
 * Exit-bounded: read roster -> build SQL -> write artifact -> exit.
 * Exit 0 on success, 1 on fatal error. No network, no DB connection.
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_ROSTER_PATH = join(
  __dirname,
  "..",
  "data",
  "texas_county_roster_v1.json",
);
const DEFAULT_OUT_PATH = join(
  __dirname,
  "..",
  "data",
  "county_manifest_seed.generated.sql",
);

function log(msg: string): void {
  console.log(`[county-manifest-seed] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[county-manifest-seed] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Roster row shapes (the subset of fields this script reads).
// ---------------------------------------------------------------------------

interface RosterCounty {
  record_type: string;
  fips: string;
  name: string;
  identity: {
    population: { status: string; value: number | null };
    parcel_count_est: number | null;
  };
  geometry: {
    in_stratmap: boolean;
    vintage_yyyymm: string | null;
  };
  cadastral: {
    verification: string | null;
    vendor_pattern: string | null;
  };
  join_quality: {
    prop_id_bad_rate: number | null;
    join_key: string;
    owner_match_gate_required: boolean;
  };
  zoning_regime: {
    unincorporated: string;
    doctrine: string;
  };
  risk_class: string[];
  cost_estimate: {
    estimated_usd: number | null;
    method: string | null;
  };
}

interface RosterFile {
  schema_version: string;
  generated_at: string;
  counties: RosterCounty[];
}

// ---------------------------------------------------------------------------
// SQL-literal helpers. PURE, unit-testable without a DB or file I/O.
// ---------------------------------------------------------------------------

/** Single-quote a SQL string literal, doubling embedded quotes. NULL passthrough for null/undefined. */
export function sqlString(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** A SQL numeric literal, or NULL. */
export function sqlNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "NULL";
  return String(v);
}

/** A SQL boolean literal. */
export function sqlBoolean(v: boolean): string {
  return v ? "true" : "false";
}

/** A SQL text[] literal from a string array, e.g. {'a','b'}. Empty array -> '{}'. */
export function sqlTextArray(values: string[]): string {
  if (values.length === 0) return "'{}'::text[]";
  const items = values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",");
  return `'{${items}}'::text[]`;
}

// ---------------------------------------------------------------------------
// Row builders. PURE — take a roster county, return the VALUES tuple text.
// ---------------------------------------------------------------------------

/** Build one county_manifest VALUES(...) tuple from a roster county row. */
export function buildManifestRow(
  county: RosterCounty,
  rosterSchemaVersion: string,
  rosterGeneratedAt: string,
): string {
  const fields = [
    sqlString(county.fips),
    sqlString(county.name),
    sqlNumber(county.identity.parcel_count_est),
    sqlNumber(county.identity.population.value),
    sqlString(county.identity.population.status ?? "unverified"),
    sqlBoolean(Boolean(county.geometry.in_stratmap)),
    sqlString(county.geometry.vintage_yyyymm),
    sqlString(county.cadastral.verification),
    sqlString(county.cadastral.vendor_pattern),
    sqlString(county.join_quality.join_key ?? "prop_id"),
    sqlNumber(county.join_quality.prop_id_bad_rate),
    sqlBoolean(Boolean(county.join_quality.owner_match_gate_required)),
    sqlTextArray(county.risk_class ?? []),
    sqlNumber(county.cost_estimate?.estimated_usd ?? null),
    sqlString(county.cost_estimate?.method ?? null),
    sqlString(rosterSchemaVersion),
    sqlString(rosterGeneratedAt),
  ];
  return `  (${fields.join(", ")})`;
}

/**
 * Build one county_facet_coverage VALUES(...) tuple for the zoning
 * county-level-unincorporated-absence seed, or null if this county's
 * roster doctrine does not read as an honest absence finding (defensive —
 * every county row inspected in the spec's live read carried the literal
 * doctrine string, but a future roster refresh could vary this).
 *
 * FIX 2026-08-08 (fix/manifest-doctrine-honesty, see doc_repo
 * `_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md` section 7-8): this
 * row is emitted as `rail_state = 'not-yet'`, NOT `satisfied-absent`. The
 * roster doctrine is a single literal string
 * ("PASS — county unincorporated = honest absence") repeated identically
 * across all 254 counties, self-reporting `verification: "verified"" when
 * no per-county verification ever happened — it is a scope-qualified,
 * true finding (unincorporated territory is unzoned by definition) but it
 * is NOT a county-wide zoning completeness finding: Texas has 1,223
 * incorporated cities carrying the actual zoning, and this doctrine says
 * nothing about them. The original `satisfied-absent` emission let this
 * one repeated doctrine string count as "done" for the zoning rail on all
 * 254 counties, driving 4.723 of the reported 4.759 percent statewide
 * completeness (99.2 percent of the headline number) from a definition,
 * not a measurement — see the `fix/manifest-doctrine-honesty` PR. The
 * finding is preserved as a citation in `absence_basis` (scope-qualified,
 * explicit about what it does and does not cover) so it is not erased,
 * only correctly excluded from the completeness rollup until incorporated
 * -area zoning is actually assessed (spec section 8, still deferred).
 */
export function buildZoningAbsenceRow(
  county: RosterCounty,
  thresholdPct: number,
): string | null {
  const doctrine = county.zoning_regime?.doctrine;
  if (!doctrine || !/PASS/i.test(doctrine)) return null;
  const scopedAbsenceBasis =
    `SCOPE-LIMITED — roster doctrine "${doctrine}" establishes unincorporated ` +
    `territory is unzoned by definition, not by per-county measurement. Does ` +
    `NOT resolve the zoning rail for this county's incorporated cities (Texas ` +
    `has 1,223 incorporated cities carrying actual zoning). Seeded as not-yet, ` +
    `not satisfied-absent, because county-wide zoning completeness cannot be ` +
    `claimed until incorporated-area zoning is assessed.`;
  const fields = [
    sqlString(county.fips), // county_fips
    sqlString("zoning"), // facet
    sqlNumber(0), // honest_coverage_pct (absence renders 0, per existing convention)
    sqlString("n/a"), // integrity_verdict (no owner oracle for zoning)
    "NULL", // owner_match_rate
    sqlString("zoning-regime-doctrine"), // source
    sqlString(null), // source_vintage
    sqlNumber(0), // sampled
    sqlString("real-at-ceiling"), // classification (an honest, provable absence is not a gap)
    sqlString("not-yet"), // rail_state — NOT satisfied-absent; see function doc above
    sqlNumber(thresholdPct), // threshold_pct
    sqlString(scopedAbsenceBasis), // absence_basis — scope-qualified, not the bare doctrine string
    sqlString("roster-load"), // verified_by_instrument
    sqlString("roster-load"), // verification_method
    sqlString(
      "doc_repo/_catalog/texas_roster_v1.json#counties[].zoning_regime.doctrine",
    ), // artifact_path
  ];
  return `  (${fields.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Full artifact builder. PURE.
// ---------------------------------------------------------------------------

export interface SeedArtifactResult {
  sql: string;
  manifestRowCount: number;
  zoningAbsenceRowCount: number;
  skippedZoningCount: number;
}

const ZONING_THRESHOLD_PCT = 95; // county_rail.threshold_pct for the 'zoning' rail (spine), per ruling 3's tuning start.

export function buildSeedArtifact(roster: RosterFile): SeedArtifactResult {
  const counties = roster.counties.filter((c) => c.record_type === "county");

  const manifestRows = counties.map((c) =>
    buildManifestRow(c, roster.schema_version, roster.generated_at),
  );

  const zoningRowsRaw = counties.map((c) =>
    buildZoningAbsenceRow(c, ZONING_THRESHOLD_PCT),
  );
  const zoningRows = zoningRowsRaw.filter((r): r is string => r !== null);
  const skippedZoningCount = zoningRowsRaw.length - zoningRows.length;

  const header = `-- County Manifest Sprint 1 — GENERATED seed artifact. DO NOT EDIT BY HAND.
--
-- Generated by artifacts/api-server/src/countyManifestSeedCli.ts from
-- artifacts/api-server/data/texas_county_roster_v1.json
-- (roster schema_version=${roster.schema_version}, generated_at=${roster.generated_at}).
--
-- Two statement groups:
--   1. county_manifest      — ${manifestRows.length} rows, one per Texas county.
--   2. county_facet_coverage — ${zoningRows.length} zoning not-yet rows,
--      scope-qualified by a county-level unincorporated-absence doctrine
--      citation in absence_basis (does NOT cover incorporated cities —
--      spec section 8, deferred; NOT satisfied-absent, see fix/manifest-
--      doctrine-honesty — a doctrine finding about unincorporated
--      territory cannot satisfy county-wide zoning completeness).
--
-- This artifact makes NO database connection when generated and is NOT
-- applied by countyManifestSeedCli.ts. Applying it against a target
-- Postgres is a separate, explicitly authorized step (spec build order
-- section 9, step 5-6).
--
-- Prerequisite: migrations 0068 (county_manifest, county_rail) and 0069
-- (county_facet_coverage additive columns) must be applied first.

BEGIN;

INSERT INTO county_manifest (
  county_fips, county_name, parcel_count_est, population_est,
  population_status, in_stratmap, stratmap_vintage, cad_verification,
  cad_vendor_pattern, join_key_kind, prop_id_bad_rate,
  owner_match_gate_required, risk_class, cost_estimate_usd,
  cost_estimate_method, roster_schema_version, roster_generated_at
) VALUES
${manifestRows.join(",\n")}
ON CONFLICT (county_fips) DO UPDATE SET
  county_name = EXCLUDED.county_name,
  parcel_count_est = EXCLUDED.parcel_count_est,
  population_est = EXCLUDED.population_est,
  population_status = EXCLUDED.population_status,
  in_stratmap = EXCLUDED.in_stratmap,
  stratmap_vintage = EXCLUDED.stratmap_vintage,
  cad_verification = EXCLUDED.cad_verification,
  cad_vendor_pattern = EXCLUDED.cad_vendor_pattern,
  join_key_kind = EXCLUDED.join_key_kind,
  prop_id_bad_rate = EXCLUDED.prop_id_bad_rate,
  owner_match_gate_required = EXCLUDED.owner_match_gate_required,
  risk_class = EXCLUDED.risk_class,
  cost_estimate_usd = EXCLUDED.cost_estimate_usd,
  cost_estimate_method = EXCLUDED.cost_estimate_method,
  roster_schema_version = EXCLUDED.roster_schema_version,
  roster_generated_at = EXCLUDED.roster_generated_at,
  updated_at = now();

-- Zoning county-level-unincorporated-absence seed. ON CONFLICT DO NOTHING
-- so this NEVER overwrites a scorer-written row (countyCoverageScoreCli.ts
-- real zoning scores for the live 19 counties must survive untouched).
INSERT INTO county_facet_coverage (
  county_fips, facet, honest_coverage_pct, integrity_verdict,
  owner_match_rate, source, source_vintage, sampled, classification,
  rail_state, threshold_pct, absence_basis, verified_by_instrument,
  verification_method, artifact_path
) VALUES
${zoningRows.join(",\n")}
ON CONFLICT (county_fips, facet) DO NOTHING;

COMMIT;
`;

  return {
    sql: header,
    manifestRowCount: manifestRows.length,
    zoningAbsenceRowCount: zoningRows.length,
    skippedZoningCount,
  };
}

// ---------------------------------------------------------------------------
// main — read roster, build artifact, write file. NO DB CONNECTION.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      roster: { type: "string" },
      out: { type: "string" },
    },
  });

  const rosterPath = values.roster
    ? resolve(values.roster)
    : DEFAULT_ROSTER_PATH;
  const outPath = values.out ? resolve(values.out) : DEFAULT_OUT_PATH;

  let roster: RosterFile;
  try {
    const raw = readFileSync(rosterPath, "utf8");
    roster = JSON.parse(raw) as RosterFile;
  } catch (err) {
    fail(
      `could not read/parse roster at ${rosterPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!Array.isArray(roster.counties) || roster.counties.length === 0) {
    fail(`roster at ${rosterPath} has no counties[] array`);
  }

  const result = buildSeedArtifact(roster);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.sql, "utf8");

  log(`roster:              ${rosterPath}`);
  log(`roster counties:      ${roster.counties.length}`);
  log(`manifest rows:        ${result.manifestRowCount}`);
  log(`zoning absence rows:   ${result.zoningAbsenceRowCount}`);
  log(`zoning rows skipped:   ${result.skippedZoningCount}`);
  log(`artifact written to:  ${outPath}`);
  log(
    `NO DATABASE CONNECTION WAS MADE. Applying this SQL is a separate, explicitly authorized step.`,
  );

  if (result.manifestRowCount !== 254) {
    log(
      `WARNING: expected 254 counties, got ${result.manifestRowCount} — roster may be stale or partial.`,
    );
  }
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
    console.error("[county-manifest-seed] FATAL:", err);
    process.exit(1);
  });
}
