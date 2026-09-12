/**
 * cad-ingest run record (P-169 / A-132, load manifest).
 *
 * Every input file this run consumes is named with its sha256 and byte
 * size in a queryable row — not only a Cloud Logging line — so a later
 * investigation (see P-171: a 2026-09-07 atoms write had no execution log
 * at all) can find what a run actually read without depending on log
 * retention. The table is created idempotently at job start rather than
 * routed through the shared numbered drizzle migration ledger under
 * `lib/db/drizzle/`, to avoid a migration-number collision with the many
 * concurrently active LDT lanes bumping that sequence right now; flagged
 * in this lane's close for the planner to formalize later if wanted.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type pg from "pg";

export interface InputFileRecord {
  role: string;
  name: string;
  sha256: string;
  bytes: number;
}

export const CAD_INGEST_RUN_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS cad_ingest_run (
  id text PRIMARY KEY,
  county_fips text NOT NULL,
  target text NOT NULL,
  cloud_run_job text,
  cloud_run_execution text,
  tax_year integer,
  source_vintage text,
  files jsonb NOT NULL,
  status text NOT NULL,
  rows_read integer,
  rows_parsed integer,
  rows_upserted integer,
  rows_skipped integer,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
)`;

export async function ensureCadIngestRunTable(pool: pg.Pool): Promise<void> {
  await pool.query(CAD_INGEST_RUN_TABLE_DDL);
}

/** Streamed sha256 + byte count — never buffers a whole file in memory. */
export async function hashInputFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const st = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes: st.size };
}

export interface StartRunFields {
  countyFips: string;
  target: string;
  files: InputFileRecord[];
  taxYear?: number;
  sourceVintage?: string;
  env?: NodeJS.ProcessEnv;
}

export async function startCadIngestRun(
  pool: pg.Pool,
  fields: StartRunFields,
): Promise<string> {
  const env = fields.env ?? process.env;
  const id = randomUUID();
  await ensureCadIngestRunTable(pool);
  await pool.query(
    `INSERT INTO cad_ingest_run (
       id, county_fips, target, cloud_run_job, cloud_run_execution,
       tax_year, source_vintage, files, status, started_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'running',now())`,
    [
      id,
      fields.countyFips,
      fields.target,
      env.CLOUD_RUN_JOB ?? null,
      env.CLOUD_RUN_EXECUTION ?? null,
      fields.taxYear ?? null,
      fields.sourceVintage ?? null,
      JSON.stringify(fields.files),
    ],
  );
  return id;
}

export interface FinishRunFields {
  status: "success" | "error";
  rowsRead?: number;
  rowsParsed?: number;
  rowsUpserted?: number;
  rowsSkipped?: number;
  error?: string;
}

export async function finishCadIngestRun(
  pool: pg.Pool,
  runId: string,
  fields: FinishRunFields,
): Promise<void> {
  await pool.query(
    `UPDATE cad_ingest_run
        SET status = $2, rows_read = $3, rows_parsed = $4,
            rows_upserted = $5, rows_skipped = $6, error = $7,
            finished_at = now()
      WHERE id = $1`,
    [
      runId,
      fields.status,
      fields.rowsRead ?? null,
      fields.rowsParsed ?? null,
      fields.rowsUpserted ?? null,
      fields.rowsSkipped ?? null,
      fields.error ?? null,
    ],
  );
}
