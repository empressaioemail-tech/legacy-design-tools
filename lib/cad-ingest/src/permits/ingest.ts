/**
 * Batch insert of normalized permit rows into `permit_record`.
 *
 * ON CONFLICT (metro, record_hash) DO NOTHING — rows are immutable raw
 * public records keyed by content hash, so re-running an ingest (or
 * overlapping source files) is idempotent and exact source duplicates
 * collapse instead of erroring. This differs from `cad_property`'s
 * DO UPDATE on purpose: there a fresher roll drop replaces attributes;
 * here a re-run carries the identical rows.
 *
 * Callers pass a drizzle handle so the CLI (own pool from
 * DATABASE_URL) and tests (`withTestSchema`) share this code.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { permitRecord } from "@workspace/db/schema";
import type { PermitRecordInsert } from "@workspace/db/schema";

export type PermitIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert"
>;

export const PERMIT_INGEST_BATCH_SIZE = 1000;

export interface PermitInsertSummary {
  /** Rows actually written (conflicts/duplicates excluded). */
  rowsInserted: number;
  /** Rows offered to the insert (including conflict skips). */
  rowsAttempted: number;
  batches: number;
}

export interface PermitInsertOptions {
  batchSize?: number;
  /** Progress callback, called after each batch with rows attempted so far. */
  onBatch?: (rowsAttempted: number) => void;
}

export async function insertPermitRecords(
  db: PermitIngestDb,
  records: AsyncIterable<PermitRecordInsert> | Iterable<PermitRecordInsert>,
  opts: PermitInsertOptions = {},
): Promise<PermitInsertSummary> {
  const batchSize = opts.batchSize ?? PERMIT_INGEST_BATCH_SIZE;
  let batch: PermitRecordInsert[] = [];
  let rowsInserted = 0;
  let rowsAttempted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    // A single multi-row INSERT cannot skip the same conflicting key
    // twice, so dedupe the batch on the PK before sending.
    const seen = new Set<string>();
    const deduped = batch.filter((r) => {
      const key = `${r.metro}\x1f${r.recordHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const result = await db
      .insert(permitRecord)
      .values(deduped)
      .onConflictDoNothing({
        target: [permitRecord.metro, permitRecord.recordHash],
      });
    // node-postgres reports the number of rows actually inserted.
    const inserted = (result as { rowCount?: number | null }).rowCount;
    rowsInserted += typeof inserted === "number" ? inserted : deduped.length;
    rowsAttempted += batch.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsAttempted);
  }

  for await (const rec of records) {
    batch.push(rec);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { rowsInserted, rowsAttempted, batches };
}
