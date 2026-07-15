#!/usr/bin/env node
/**
 * Municipal permit open-data ingest CLI.
 *
 * Usage:
 *   pnpm --filter @workspace/permit-ingest permit-ingest -- \
 *     --source=san-antonio \        # or --county=48029 (48453 = austin)
 *     --file=<gs:// URL | local path> \
 *     [--vintage=<label>]           # default: derived from the file name
 *     [--batch-size=1000] [--limit=N] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 *
 * Sources: 48453 Austin (Travis, `TCAD ID` parcel key, `Permit Num`);
 * 48029 San Antonio (Bexar, `PARCEL` parcel key, `PERMIT`). Column
 * mapping is shared with the K2 calibration harness via
 * `@workspace/calibration-engines/k2`.
 *
 * gs:// inputs stream through `gcloud storage cat` (set
 * PERMIT_INGEST_GCLOUD to override the binary). If that streaming is
 * flaky, `gcloud storage cp` the file down and pass the local path.
 *
 * The run is exit-bounded: parse + upsert + summary, then exit. Exit
 * code 0 on success (even with skipped malformed rows), 1 on fatal
 * errors or when zero rows parsed.
 */

import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveSource } from "./sources";
import { newCounters } from "./types";
import { parsePermitStream } from "./normalize";
import { openInput, deriveVintage } from "./input";
import { upsertBuildingPermits, DEFAULT_BATCH_SIZE } from "./ingest";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[permit-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[permit-ingest] ERROR: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // pnpm forwards the `--` separator into argv; drop it.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      county: { type: "string" },
      file: { type: "string" },
      vintage: { type: "string" },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const sourceArg = values.source ?? values.county;
  if (!sourceArg || !values.file) {
    fail(
      "usage: permit-ingest --source=austin|san-antonio (or --county=48453|48029) " +
        "--file=<gs://...|path> [--vintage=label] [--dry-run]",
    );
  }
  const source = resolveSource(sourceArg);
  if (!source) {
    fail(
      `unknown source "${sourceArg}" — supported: austin (48453), ` +
        "san-antonio (48029)",
    );
  }

  const dryRun = values["dry-run"] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) {
    fail("DATABASE_URL must be set (or pass --dry-run to parse only)");
  }

  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    fail(`--limit must be a non-negative integer, got "${values.limit}"`);
  }
  const batchSize =
    values["batch-size"] !== undefined
      ? Number(values["batch-size"])
      : DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    fail(`--batch-size must be a positive integer, got "${values["batch-size"]}"`);
  }

  const startedAt = Date.now();
  const vintage = values.vintage ?? deriveVintage(values.file);

  const { stream, sourceFile, done } = openInput(values.file);
  log(`source=${source.fips} (${source.name}) jurisdiction=${source.jurisdiction}`);
  log(`file=${values.file}`);
  log(`source file=${sourceFile} vintage=${vintage}`);

  const counters = newCounters();
  const records = parsePermitStream(source, stream, counters, limit);

  let rowsUpserted = 0;
  try {
    if (dryRun) {
      // parse-only: drain the generator
      for await (const _rec of records) {
        void _rec;
      }
    } else {
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        const db = drizzle(pool);
        const summary = await upsertBuildingPermits(db, records, {
          sourceFile,
          sourceVintage: vintage,
          batchSize,
          onBatch: (total) => {
            if (total % 50_000 < batchSize) log(`upserted ${total} rows...`);
          },
        });
        rowsUpserted = summary.rowsUpserted;
      } finally {
        await pool.end();
      }
    }
    // Surface a non-zero gcloud exit as a fatal error.
    if (done) await done;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log("---- ingest summary ----");
  log(`source:          ${source.fips} (${source.name})`);
  log(`source file:     ${sourceFile}`);
  log(`source vintage:  ${vintage}`);
  log(`rows read:       ${counters.rowsRead}`);
  log(`rows parsed:     ${counters.rowsParsed}`);
  log(`rows upserted:   ${dryRun ? "0 (dry-run)" : rowsUpserted}`);
  log(`rows skipped:    ${counters.rowsSkipped} (malformed / no permit id)`);
  log(`duplicate rows:  ${counters.duplicateRows} (same parcel+permit in file)`);
  log(`duration:        ${seconds}s`);
  if (counters.skipSamples.length > 0) {
    log(`skip samples:    ${counters.skipSamples.join(" | ")}`);
  }
  if (counters.rowsParsed === 0) {
    fail("zero rows parsed — wrong file or column drift; nothing ingested");
  }
}

main().catch((err) => {
  console.error("[permit-ingest] FATAL:", err);
  process.exit(1);
});
