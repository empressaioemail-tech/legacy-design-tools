#!/usr/bin/env node
/**
 * Reconcile RETIRED facet keys in `county_facet_coverage`.
 *
 * WHAT IS BROKEN. `countyCoverageScoreCli.ts` wrote facet `land-use` while
 * the rail key is `landuse`. `lib/db/src/manifestGridRead.ts` joins
 * `c.facet = r.rail_key`, so those rows are ORPHANED: written, joined by
 * nothing, read by no cell. Measured live 2026-08-19: 19 rows, dated
 * 2026-07-21 to 2026-08-05.
 *
 * WHY THE OBVIOUS FIX IS THE WRONG ONE, and this is the whole reason this
 * CLI exists rather than a one-line UPDATE. Renaming `land-use` to `landuse`
 * looks like the repair and is a regression. The two keys do not measure the
 * same subject:
 *
 *   land-use  (orphan)  CAD-roll JOIN RATE -- the fit between the TxGIO
 *                       parcel roster and the CAD roll, source `cad-roll` or
 *                       `cad-roll-address-join`, written by this repo's
 *                       coverage scorer.
 *   landuse   (rail)    land-use-fact ATOM COVERAGE over the parcel roster,
 *                       source `land-use-fact-atom-count`, written by
 *                       `score_cad_rails_fast.mjs`.
 *
 * Measured on the same 19 counties, the rail row is NEWER in all 19 and
 * HIGHER in all 13 currently satisfied (48027 77.76 vs 98.90, 48091 0.00 vs
 * 99.68, 48113 92.83 vs 99.91, 48491 89.14 vs 99.85). The primary key is
 * `(county_fips, facet)`, so a rename is an OVERWRITE: it would replace a
 * newer atom-coverage measurement with an older, lower join-rate one and drop
 * counties out of satisfied-present. Aliasing at read time is no better --
 * the grid join is 1:1, so two candidate rows for one cell have no rule for
 * which wins.
 *
 * WHAT THIS DOES INSTEAD. Re-keys each retired row to the DECLARED NON-RAIL
 * diagnostic key `landuse-cad-join` (see
 * `lib/db/src/schema/facetKeyRegistry.ts`). The measurement is preserved, it
 * stops wearing a rail-shaped name, and it still joins nothing -- which is
 * correct, because join quality was RULED not a rail on 2026-08-08 (doc_repo
 * `_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md`).
 *
 * DRY-RUN IS THE DEFAULT AND `--apply` IS AN OPERATOR DECISION. Deletions and
 * retirements are operator rulings (DEV_PROCESS 5.4). This CLI never deletes;
 * the destructive alternative is named in the report so the operator can rule
 * on it with the evidence in front of them.
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyFacetKeyReconcileCli.ts            # dry-run
 *   tsx artifacts/api-server/src/countyFacetKeyReconcileCli.ts --apply    # writes
 *
 * Exit-bounded: connect -> read -> report -> (optional single transaction) ->
 * exit. Exit 0 on success, 1 on fatal error, 2 when a conflict blocks an
 * apply.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";

import {
  RETIRED_FACET_KEYS,
  DIAGNOSTIC_FACET_KEYS,
  RAIL_FACET_KEYS,
} from "@workspace/db/schema";

const { Pool } = pg;

/** Where each retired key's rows are re-keyed to. */
export const RETIRED_KEY_TARGET: Readonly<Record<string, string>> = {
  "land-use": "landuse-cad-join",
};

function log(msg: string): void {
  console.log(`[facet-key-reconcile] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[facet-key-reconcile] ERROR: ${msg}`);
  process.exit(1);
}

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

export interface RetiredRowPlan {
  countyFips: string;
  fromFacet: string;
  toFacet: string;
  honestCoveragePct: string;
  source: string | null;
  checkedAt: string;
  /** A row already sits at the target key for this county. */
  targetOccupied: boolean;
  /** The rail row this must NEVER be merged into, for the report. */
  railFacet: string | null;
  railCoveragePct: string | null;
  railSource: string | null;
  railState: string | null;
}

/**
 * Build the plan. PURE relative to the database read, so the dry-run and the
 * apply act on exactly the same rows -- a dry-run that computes a different
 * set from the apply proves nothing.
 */
export function planFromRows(
  rows: ReadonlyArray<{
    county_fips: string;
    facet: string;
    honest_coverage_pct: string;
    source: string | null;
    checked_at: string;
    target_exists: boolean;
    rail_facet: string | null;
    rail_pct: string | null;
    rail_source: string | null;
    rail_state: string | null;
  }>,
): RetiredRowPlan[] {
  return rows.map((r) => ({
    countyFips: r.county_fips,
    fromFacet: r.facet,
    toFacet: RETIRED_KEY_TARGET[r.facet] ?? "",
    honestCoveragePct: r.honest_coverage_pct,
    source: r.source,
    checkedAt: r.checked_at,
    targetOccupied: r.target_exists,
    railFacet: r.rail_facet,
    railCoveragePct: r.rail_pct,
    railSource: r.rail_source,
    railState: r.rail_state,
  }));
}

/**
 * The re-key target must be a DECLARED diagnostic key and must NOT be a rail
 * key. Checked before any statement runs: a reconcile that re-keys orphans
 * onto a rail is the exact regression this file exists to refuse.
 */
export function assertTargetsAreDiagnostic(): void {
  for (const [from, to] of Object.entries(RETIRED_KEY_TARGET)) {
    if (!RETIRED_FACET_KEYS.has(from)) {
      throw new Error(`'${from}' is not a retired facet key`);
    }
    if (RAIL_FACET_KEYS.has(to)) {
      throw new Error(
        `refusing to re-key '${from}' onto RAIL key '${to}': the rail measures ` +
          "a different subject and the primary key would overwrite it",
      );
    }
    if (!DIAGNOSTIC_FACET_KEYS.has(to)) {
      throw new Error(
        `'${to}' is not a declared diagnostic key; declare it in ` +
          "lib/db/src/schema/facetKeyRegistry.ts first",
      );
    }
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: { apply: { type: "boolean", default: false } },
  });
  const apply = values.apply ?? false;

  assertTargetsAreDiagnostic();

  const pool = new Pool({
    connectionString: resolveDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  let exitCode = 0;
  try {
    const retired = [...RETIRED_FACET_KEYS];
    const targets = retired.map((k) => RETIRED_KEY_TARGET[k] ?? "");
    const { rows } = await pool.query(
      `SELECT
         c.county_fips,
         c.facet,
         c.honest_coverage_pct::text AS honest_coverage_pct,
         c.source,
         c.checked_at::text AS checked_at,
         EXISTS (
           SELECT 1 FROM county_facet_coverage t
            WHERE t.county_fips = c.county_fips AND t.facet = ANY($2::text[])
         ) AS target_exists,
         r.facet          AS rail_facet,
         r.honest_coverage_pct::text AS rail_pct,
         r.source         AS rail_source,
         r.rail_state     AS rail_state
       FROM county_facet_coverage c
       LEFT JOIN county_facet_coverage r
         ON r.county_fips = c.county_fips AND r.facet = 'landuse'
      WHERE c.facet = ANY($1::text[])
      ORDER BY c.county_fips`,
      [retired, targets],
    );

    const plan = planFromRows(rows as never);
    log(`retired-key rows found: ${plan.length}`);
    if (plan.length === 0) {
      log("nothing to reconcile");
      return;
    }

    log("");
    log(
      "county   from       -> to                 orphan%  rail%   rail source                 rail state",
    );
    for (const p of plan) {
      log(
        `${p.countyFips}    ${p.fromFacet.padEnd(10)} -> ${p.toFacet.padEnd(18)} ` +
          `${(p.honestCoveragePct ?? "").padStart(6)}  ` +
          `${(p.railCoveragePct ?? "none").padStart(6)}  ` +
          `${(p.railSource ?? "none").padEnd(26)} ${p.railState ?? "none"}`,
      );
    }

    // The counter-evidence, printed every run so the destructive alternative
    // can never look harmless: how many rail cells a merge would overwrite.
    const wouldOverwrite = plan.filter((p) => p.railFacet !== null).length;
    const wouldDemote = plan.filter(
      (p) =>
        p.railState === "satisfied-present" &&
        p.railCoveragePct !== null &&
        Number(p.honestCoveragePct) < Number(p.railCoveragePct),
    ).length;
    log("");
    log(
      `merging these rows into rail 'landuse' would overwrite ${wouldOverwrite} rail cells, ` +
        `${wouldDemote} of them satisfied-present with a HIGHER number. That is why this ` +
        "CLI re-keys to a non-rail diagnostic instead.",
    );

    const conflicts = plan.filter((p) => p.targetOccupied);
    if (conflicts.length > 0) {
      log("");
      log(
        `CONFLICT: ${conflicts.length} counties already hold a row at the target key. ` +
          "Re-keying would violate the (county_fips, facet) primary key. No write attempted.",
      );
      exitCode = 2;
    }

    if (!apply) {
      log("");
      log("DRY-RUN — no rows changed. Re-run with --apply to write.");
      return;
    }
    if (conflicts.length > 0) {
      log("--apply refused while conflicts stand");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let updated = 0;
      for (const p of plan) {
        const r = await client.query(
          `UPDATE county_facet_coverage
              SET facet = $3
            WHERE county_fips = $1 AND facet = $2`,
          [p.countyFips, p.fromFacet, p.toFacet],
        );
        updated += r.rowCount ?? 0;
      }
      if (updated !== plan.length) {
        await client.query("ROLLBACK");
        fail(
          `planned ${plan.length} updates, applied ${updated} — rolled back rather ` +
            "than leave a partial re-key",
        );
      }
      await client.query("COMMIT");
      log(`APPLIED — ${updated} rows re-keyed`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  if (exitCode !== 0) process.exit(exitCode);
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
    console.error("[facet-key-reconcile] FATAL:", err);
    process.exit(1);
  });
}
