/**
 * P-85 item 6 — artifact row writes from the Playwright worker.
 */

import pg from "pg";

const { Pool } = pg;

export type AcquisitionMethod = "download" | "purchase" | "capture" | "human";

export interface NewArtifactRow {
  jobId: string;
  portalId: string;
  recordingRef: string | null;
  documentType: string | null;
  recordingDate: string | null;
  parties: string | null;
  acquisitionMethod: AcquisitionMethod;
  contentSha256: string;
  byteSize: number | null;
  purchaseCostCents?: number | null;
  detailUrl?: string | null;
  storagePath?: string | null;
  metadata?: Record<string, unknown>;
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

export async function insertRecordsRequestArtifact(
  row: NewArtifactRow,
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO records_request_artifacts (
      job_id,
      portal_id,
      recording_ref,
      document_type,
      recording_date,
      parties,
      acquisition_method,
      content_sha256,
      byte_size,
      purchase_cost_cents,
      detail_url,
      storage_path,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
    RETURNING id`,
    [
      row.jobId,
      row.portalId,
      row.recordingRef,
      row.documentType,
      row.recordingDate,
      row.parties,
      row.acquisitionMethod,
      row.contentSha256,
      row.byteSize,
      row.purchaseCostCents ?? null,
      row.detailUrl ?? null,
      row.storagePath ?? null,
      JSON.stringify(row.metadata ?? {}),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("records_request_artifacts insert returned no id");
  }
  return id;
}
