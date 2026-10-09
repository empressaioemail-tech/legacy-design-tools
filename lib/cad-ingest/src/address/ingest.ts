/**
 * Batch load of normalized address-point records into `txgio_address`.
 *
 * Replace semantics per county: the caller deletes the county's rows
 * first (`deleteCountyAddresses`), then streams inserts. Insert batches
 * still carry ON CONFLICT DO UPDATE so a resumed/re-run load after a
 * partial failure is idempotent without a second delete. The key is
 * (county_fips, object_id) as of migration 0110 — changed from
 * (county_fips, full_addr, unit), which silently collapsed distinct
 * delivery points that happened to share a label (measured Burnet
 * 2026-10-09: 35,857 service points, only 35,690 stored, 167 lost
 * across 86 colliding groups with no shared coordinates). The same
 * delivery point re-fetched in a fresher vintage still updates in
 * place, because object_id is stable within a county across a
 * wholesale reload (see module docs on `deleteCountyAddresses`).
 *
 * Callers pass a drizzle handle so the CLI (own pool from DATABASE_URL)
 * and tests (`withTestSchema`) share this code — same pattern as
 * `../txgio/ingest.ts`.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioAddress } from "@workspace/db/schema";
import type { TxgioAddressRecord } from "./parse";

/** Minimal structural slice of a drizzle node-postgres database. */
export type AddressIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

export const ADDRESS_DEFAULT_BATCH_SIZE = 1000;

export async function deleteCountyAddresses(
  db: AddressIngestDb,
  countyFips: string,
): Promise<void> {
  await db
    .delete(txgioAddress)
    .where(sql`${txgioAddress.countyFips} = ${countyFips}`);
}

export interface AddressUpsertOptions {
  /** Source label recorded on every row (the service layer path). */
  sourceFile: string;
  /** Program vintage label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each batch. */
  onBatch?: (totalRowsInserted: number) => void;
}

export interface AddressUpsertSummary {
  /**
   * Rows the database actually affected (drizzle `.returning()` row
   * count on the real INSERT ... ON CONFLICT statement), NOT the number
   * of records streamed in. Before this fix the field summed
   * `batch.length`, which counted a conflict-UPDATE as an insert — the
   * mechanism behind Burnet (2026-10-09) logging "35,750 rows inserted"
   * while only 35,690 rows were ever stored.
   */
  rowsInserted: number;
  batches: number;
  /**
   * Records dropped because the SAME (county_fips, object_id) was
   * already sent earlier in this same load — should not happen,
   * object_id is the source service's statewide-unique OBJECTID, but
   * counted rather than silently absorbed by ON CONFLICT DO UPDATE if
   * it ever does.
   */
  duplicateObjectIds: number;
}

export async function upsertAddresses(
  db: AddressIngestDb,
  records: AsyncIterable<TxgioAddressRecord> | Iterable<TxgioAddressRecord>,
  opts: AddressUpsertOptions,
): Promise<AddressUpsertSummary> {
  const batchSize = opts.batchSize ?? ADDRESS_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txgioAddress.$inferInsert;
  let batch: InsertRow[] = [];
  // Guard against a same-key duplicate ANYWHERE in this load, not just
  // within one batch — a single INSERT cannot update the same conflict
  // target twice, and a duplicate split across two batches would
  // otherwise be silently absorbed as a second conflict-UPDATE instead
  // of being counted. Scoped to the whole call (never reset), unlike the
  // old per-batch Set this replaces.
  const seenKeys = new Set<string>();
  let rowsInserted = 0;
  let duplicateObjectIds = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const result = await db
      .insert(txgioAddress)
      .values(batch)
      .onConflictDoUpdate({
        target: [txgioAddress.countyFips, txgioAddress.objectId],
        set: {
          fullAddr: sql`excluded.full_addr`,
          unit: sql`excluded.unit`,
          addNumber: sql`excluded.add_number`,
          stName: sql`excluded.st_name`,
          postComm: sql`excluded.post_comm`,
          postCode: sql`excluded.post_code`,
          state: sql`excluded.state`,
          countyName: sql`excluded.county_name`,
          source: sql`excluded.source`,
          dateAcq: sql`excluded.date_acq`,
          longitude: sql`excluded.longitude`,
          latitude: sql`excluded.latitude`,
          tileKey: sql`excluded.tile_key`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      })
      // Count what the database actually affected, not the batch size
      // sent — see AddressUpsertSummary.rowsInserted.
      .returning({ objectId: txgioAddress.objectId });
    rowsInserted += result.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsInserted);
  }

  for await (const rec of records) {
    const key = `${rec.countyFips}|${rec.objectId}`;
    if (seenKeys.has(key)) {
      duplicateObjectIds += 1;
      continue;
    }
    seenKeys.add(key);
    batch.push({
      countyFips: rec.countyFips,
      fullAddr: rec.fullAddr,
      unit: rec.unit,
      objectId: rec.objectId,
      addNumber: rec.addNumber,
      stName: rec.stName,
      postComm: rec.postComm,
      postCode: rec.postCode,
      state: rec.state,
      countyName: rec.countyName,
      source: rec.source,
      dateAcq: rec.dateAcq,
      longitude: rec.longitude,
      latitude: rec.latitude,
      tileKey: rec.tileKey,
      sourceFile: opts.sourceFile,
      sourceVintage: opts.sourceVintage,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { rowsInserted, batches, duplicateObjectIds };
}
