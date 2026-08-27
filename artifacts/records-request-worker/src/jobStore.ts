/**
 * P-85 item 5 — job row load/update for the Playwright worker.
 * Uses raw pg so the Cloud Run image stays self-contained (hydrology-worker pattern).
 */

import pg from "pg";

const { Pool } = pg;

export type RecordsRequestJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "needs-human"
  | "awaiting-purchase-approval";

export interface RecordsRequestJobRow {
  id: string;
  engagementId: string;
  placeKey: string | null;
  userId: string;
  userEmail: string | null;
  parcelKey: string;
  countyFips: string;
  status: RecordsRequestJobStatus;
  requestPayload: Record<string, unknown> | null;
  scopeSearched: Record<string, unknown> | null;
  recipeVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL must be set");
  }
  return url;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  }
  return pool;
}

/** Test seam — closes the shared pool. */
export async function closeJobStorePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function loadRecordsRequestJob(
  jobId: string,
): Promise<RecordsRequestJobRow | null> {
  const result = await getPool().query<RecordsRequestJobRow>(
    `SELECT
      id,
      engagement_id AS "engagementId",
      place_key AS "placeKey",
      user_id AS "userId",
      user_email AS "userEmail",
      parcel_key AS "parcelKey",
      county_fips AS "countyFips",
      status,
      request_payload AS "requestPayload",
      scope_searched AS "scopeSearched",
      recipe_version AS "recipeVersion",
      error_code AS "errorCode",
      error_message AS "errorMessage",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      completed_at AS "completedAt"
    FROM records_request_jobs
    WHERE id = $1
    LIMIT 1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function markRecordsRequestJobRunning(jobId: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE records_request_jobs
     SET status = 'running', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [jobId],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `records_request_jobs ${jobId}: expected queued row to transition to running`,
    );
  }
}

export interface TerminalJobUpdate {
  status: "complete" | "failed" | "needs-human";
  scopeSearched?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function markRecordsRequestJobTerminal(
  jobId: string,
  update: TerminalJobUpdate,
): Promise<void> {
  const result = await getPool().query(
    `UPDATE records_request_jobs
     SET
       status = $2,
       scope_searched = COALESCE($3, scope_searched),
       error_code = $4,
       error_message = $5,
       updated_at = NOW(),
       completed_at = NOW()
     WHERE id = $1 AND status = 'running'`,
    [
      jobId,
      update.status,
      update.scopeSearched ?? null,
      update.errorCode ?? null,
      update.errorMessage ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `records_request_jobs ${jobId}: expected running row to transition to ${update.status}`,
    );
  }
}
