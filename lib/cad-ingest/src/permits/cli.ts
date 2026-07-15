#!/usr/bin/env node
/**
 * Municipal issued-permit corpus ingest CLI (feat/permits-brief-slot).
 *
 * Loads the OWNED Austin / San Antonio permit CSVs (public-record
 * acquisition, calibrated-spine Wave 3) into `permit_record`. The raw
 * corpus lives in GCS — copy it local first (needs bucket access):
 *
 *   gcloud storage cp "gs://hauska-calibration-raw/backtest/austin_tx/permit/open_data/acquired=2026-06-21/data/issued_construction_permits.csv" .
 *   gcloud storage cp "gs://hauska-calibration-raw/backtest/san_antonio_tx/permit/open_data/acquired=2026-06-21/data/permits_issued_2020_2024.csv" .
 *   gcloud storage cp "gs://hauska-calibration-raw/backtest/san_antonio_tx/permit/open_data/acquired=2026-06-21/data/permits_issued_current.csv" .
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest permits-ingest -- \
 *     --metro=austin_tx|san_antonio_tx \
 *     --file=<local CSV path> \
 *     [--acquired=2026-06-21]   # GCS acquired= partition date (default shown)
 *     [--batch-size=1000] [--limit=N] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres unless --dry-run.
 * Re-runs are idempotent (content-hash PK, ON CONFLICT DO NOTHING).
 *
 * The run is exit-bounded: parse + insert + summary, then exit. Exit
 * code 0 on success (even with skipped malformed rows), 1 on fatal
 * errors or when zero rows parsed.
 */

import { parseArgs } from "node:util";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PermitRecordInsert } from "@workspace/db/schema";
import { HeaderIndex, readCsvRows } from "../csv";
import {
  assertPermitHeader,
  newPermitCounters,
  normalizePermitRow,
  type PermitMetro,
} from "./normalize";
import { insertPermitRecords, PERMIT_INGEST_BATCH_SIZE } from "./ingest";

const { Pool } = pg;

const DEFAULT_ACQUIRED_DATE = "2026-06-21";

function log(msg: string): void {
  console.log(`[permits-ingest] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[permits-ingest] ERROR: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      metro: { type: "string" },
      file: { type: "string" },
      acquired: { type: "string", default: DEFAULT_ACQUIRED_DATE },
      "batch-size": { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const metro = values.metro as PermitMetro | undefined;
  if (metro !== "austin_tx" && metro !== "san_antonio_tx") {
    fail("--metro must be austin_tx or san_antonio_tx");
  }
  const filePath = values.file;
  if (!filePath) fail("--file=<local CSV path> is required");
  try {
    const s = await stat(filePath);
    if (!s.isFile()) fail(`--file is not a regular file: ${filePath}`);
  } catch {
    fail(`--file not found: ${filePath}`);
  }
  const acquiredDate = values.acquired ?? DEFAULT_ACQUIRED_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredDate)) {
    fail("--acquired must be an ISO date (YYYY-MM-DD)");
  }
  const batchSize = values["batch-size"]
    ? Number(values["batch-size"])
    : PERMIT_INGEST_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    fail("--batch-size must be a positive integer");
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  if (values.limit && (!Number.isInteger(limit) || limit < 1)) {
    fail("--limit must be a positive integer");
  }
  const dryRun = values["dry-run"] === true;

  const sourceFile = basename(filePath);
  const counters = newPermitCounters();
  let header: HeaderIndex | null = null;

  async function* records(): AsyncGenerator<PermitRecordInsert> {
    for await (const row of readCsvRows(filePath as string)) {
      if (header === null) {
        header = new HeaderIndex(row);
        assertPermitHeader(metro as PermitMetro, header);
        continue;
      }
      if (counters.rowsRead >= limit) return;
      counters.rowsRead += 1;
      const rec = normalizePermitRow({
        metro: metro as PermitMetro,
        header,
        row,
        sourceFile,
        acquiredDate,
      });
      if (rec === null) {
        counters.skippedNoPermitNumber += 1;
        continue;
      }
      if (rec.addressNormalized === null) counters.rowsWithoutMatchKey += 1;
      counters.rowsEmitted += 1;
      yield rec;
    }
  }

  log(`metro=${metro} file=${sourceFile} acquired=${acquiredDate} dryRun=${dryRun}`);

  if (dryRun) {
    // Parse-only pass — no DB.
    for await (const _rec of records()) {
      // counting happens in the generator
    }
    if (counters.rowsEmitted === 0) fail("zero rows parsed");
    log(`DRY RUN — parsed ${JSON.stringify(counters)}`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL must be set (or pass --dry-run)");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  try {
    const summary = await insertPermitRecords(db, records(), {
      batchSize,
      onBatch: (n) => {
        if (n % 100_000 < batchSize) log(`...${n} rows attempted`);
      },
    });
    if (counters.rowsEmitted === 0) fail("zero rows parsed");
    log(`DONE ${JSON.stringify({ ...counters, ...summary })}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
