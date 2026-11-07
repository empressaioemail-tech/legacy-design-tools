/**
 * CLI: reconcile Williamson (48491) cad_property.land_value/land_acres
 * from tx_wcad_ag_valuation (F-01). See williamsonAgValuation.ts's own
 * module doc for the full defect background and design.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest williamson-ag-valuation-reconcile
 *
 * Dry-run (aggregate + guard, print the honest summary, no write):
 *   ... -- --dry-run
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  buildReconciliationRecords,
  aggregateAgValuationByPropId,
  findWilliamsonReconciliationTargets,
  reconcileWilliamsonAgValuation,
  WILLIAMSON_COUNTY_FIPS,
} from "./williamsonAgValuation.js";

function parseArgs(argv: string[]): { dryRun: boolean; sourceVintage: string } {
  let dryRun = false;
  let sourceVintage = new Date().toISOString().slice(0, 10);
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--source-vintage=")) {
      sourceVintage = a.slice("--source-vintage=".length);
    }
  }
  return { dryRun, sourceVintage };
}

function printSummary(
  label: string,
  summary: {
    targetsConsidered: number;
    noAgValuationMatch: number;
    landValueResolved: number;
    landAcresResolved: number;
    landAcresGenuinelyAbsent: number;
    guardRefusedValue: number;
    guardRefusedAcres: number;
  },
): void {
  console.log(`[williamson-ag-valuation] ${label}`);
  console.log(`  targets considered (missing land_value/land_acres): ${summary.targetsConsidered}`);
  console.log(`  no tx_wcad_ag_valuation match at all:                ${summary.noAgValuationMatch}`);
  console.log(`  land_value resolved:                                 ${summary.landValueResolved}`);
  console.log(`  land_acres resolved:                                 ${summary.landAcresResolved}`);
  console.log(`  land_acres genuinely absent (real source shape):     ${summary.landAcresGenuinelyAbsent}`);
  console.log(`  land_value guard-refused (implausible, NOT written): ${summary.guardRefusedValue}`);
  console.log(`  land_acres guard-refused (implausible, NOT written): ${summary.guardRefusedAcres}`);
  console.log(
    "  NOTE: land_acres resolving less than land_value is expected — most Residential " +
      "land rows in this source carry a dollar value with no recorded acreage. This is " +
      "not a partial failure of this reconciliation.",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!url) {
    console.error("FAIL CLOSED: DATABASE_URL or DEPLOYMENT_DATABASE_URL required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    if (args.dryRun) {
      const [targets, aggregated] = await Promise.all([
        findWilliamsonReconciliationTargets(db, WILLIAMSON_COUNTY_FIPS),
        aggregateAgValuationByPropId(db, WILLIAMSON_COUNTY_FIPS),
      ]);
      const { summary } = buildReconciliationRecords(WILLIAMSON_COUNTY_FIPS, targets, aggregated);
      printSummary("dry-run; no write", summary);
      return;
    }
    const summary = await reconcileWilliamsonAgValuation(db, args.sourceVintage);
    printSummary("applied", summary);
    console.log(`  cad_property rows upserted: ${summary.upsert.rowsUpserted} (${summary.upsert.batches} batches)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
