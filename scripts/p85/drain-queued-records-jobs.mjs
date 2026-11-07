#!/usr/bin/env node
/**
 * Drain queued records_request_jobs by POSTing each to the worker /run endpoint.
 * Usage: DATABASE_URL=... node scripts/p85/drain-queued-records-jobs.mjs [--dry-run]
 */
import pg from "pg";

// D-25: no default worker URL. The retired Google Cloud Run
// records-request-worker host is dead; a drain against it reported every queued
// job as failed. Name it, or refuse by name.
const WORKER_URL = process.env.RECORDS_REQUEST_WORKER_URL?.trim();
if (!WORKER_URL) {
  console.error(
    "RECORDS_REQUEST_WORKER_URL required and there is no default (D-25): the\n" +
      "  retired Google Cloud Run records-request-worker host is dead.",
  );
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const dryRun = process.argv.includes("--dry-run");

if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT id, county_fips, parcel_key, status, created_at
     FROM records_request_jobs
     WHERE status = 'queued'
     ORDER BY created_at ASC`,
  );

  console.log(JSON.stringify({ queued: rows.length, workerUrl: WORKER_URL }));

  for (const row of rows) {
    const jobId = row.id;
    if (dryRun) {
      console.log(JSON.stringify({ action: "dry-run", jobId, ...row }));
      continue;
    }
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    const body = await res.text();
    console.log(
      JSON.stringify({
        jobId,
        countyFips: row.county_fips,
        httpStatus: res.status,
        body: body.slice(0, 500),
      }),
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
