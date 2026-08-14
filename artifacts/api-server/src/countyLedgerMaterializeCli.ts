#!/usr/bin/env node
/**
 * County ledger MATERIALIZE CLI (L18 / P-14).
 *
 * Recomputes the GET /api/county-ledger payload (manifest grid + counties[]
 * + capability probes) and upserts county_ledger_snapshot. The route serves
 * that row in constant time. Recompute cost lives at write time, after
 * scorers/planner change county_facet_coverage or county_rail.
 *
 * HEAVY SCAN: probeRailCapabilities COUNT DISTINCT on cad_property,
 * txgio_parcel, tx_special_district. Announce before --apply on a shared
 * database. Do not run concurrent with another heavy PostGIS/full-table scan.
 *
 * NEVER touches the atoms store. The ONLY table this script writes is
 * county_ledger_snapshot, and even that is skipped under --dry-run
 * (--apply is required to write).
 *
 * Usage (from repo root):
 *   tsx artifacts/api-server/src/countyLedgerMaterializeCli.ts            # dry-run
 *   tsx artifacts/api-server/src/countyLedgerMaterializeCli.ts --apply    # writes the snapshot
 *
 * DATABASE_URL must point at the deployment Postgres (falls back to
 * loading the DEPLOYMENT_DATABASE_URL secret via gcloud, identical to
 * countyRailRefreshCli.ts).
 *
 * Scorer seam: after scoring, invoke this CLI --apply. Do not inline
 * scoring here. Export materializeCountyLedger in countyLedgerCompute.ts
 * if a process already holds a drizzle handle.
 *
 * Exit-bounded: connect -> compute -> report (-> write under --apply) -> exit.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { COUNTY_LEDGER_SNAPSHOT_ID } from "@workspace/db/schema";
import {
  computeCountyLedgerPayload,
  type SelectDb,
} from "./countyLedgerCompute";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[county-ledger-materialize] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[county-ledger-materialize] ERROR: ${msg}`);
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

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const apply = Boolean(values.apply);

  const url = resolveDatabaseUrl();
  const startedAt = Date.now();
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema });

  log(`mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  log("computing ledger payload (grid + counties + capability probes)...");
  log("HEAVY SCAN: COUNT DISTINCT on cad_property / txgio_parcel / tx_special_district");

  let payload;
  try {
    payload = await computeCountyLedgerPayload(db as unknown as SelectDb);
  } catch (err) {
    await pool.end();
    fail(err instanceof Error ? err.message : String(err));
  }

  const computedAt = new Date();
  const cells = payload.manifestCells.length;
  const satisfied = payload.summary.satisfiedCells;
  log(`computedAt:       ${computedAt.toISOString()}`);
  log(`totalCells:       ${cells}`);
  log(`satisfiedCells:   ${satisfied}`);
  log(`texasCompletenessPct: ${payload.summary.texasCompletenessPct}`);
  log(`totalCounties:    ${payload.summary.totalCounties}`);
  log(`totalRails:       ${payload.summary.totalRails}`);

  if (apply) {
    await pool.query(
      `INSERT INTO county_ledger_snapshot (id, computed_at, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET computed_at = EXCLUDED.computed_at,
             payload = EXCLUDED.payload`,
      [COUNTY_LEDGER_SNAPSHOT_ID, computedAt.toISOString(), JSON.stringify(payload)],
    );
    log(`wrote county_ledger_snapshot id=${COUNTY_LEDGER_SNAPSHOT_ID}`);
  } else {
    log("dry-run only — re-run with --apply to write the snapshot.");
  }

  await pool.end();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`duration:         ${seconds}s`);
}

function isDirectRun(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    const entryReal = realpathSync(entry);
    const thisReal = realpathSync(fileURLToPath(import.meta.url));
    return entryReal === thisReal;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
