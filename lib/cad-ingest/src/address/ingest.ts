/**
 * Batch load of normalized address-point records into `txgio_address`.
 *
 * Replace semantics per county: the caller deletes the county's rows
 * first (`deleteCountyAddresses`), then streams inserts. Insert batches
 * still carry ON CONFLICT DO UPDATE so a resumed/re-run load after a
 * partial failure is idempotent without a second delete. The key is
 * (county_fips, full_addr, unit); the same delivery point re-fetched in
 * a fresher vintage updates in place.
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
  rowsInserted: number;
  batches: number;
}

export async function upsertAddresses(
  db: AddressIngestDb,
  records: AsyncIterable<TxgioAddressRecord> | Iterable<TxgioAddressRecord>,
  opts: AddressUpsertOptions,
): Promise<AddressUpsertSummary> {
  const batchSize = opts.batchSize ?? ADDRESS_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txgioAddress.$inferInsert;
  let batch: InsertRow[] = [];
  // Guard against a same-key duplicate WITHIN a batch — a single INSERT
  // cannot update the same conflict target twice. The service can ship
  // two points sharing (full_addr, unit) in a county (data noise); keep
  // the first seen in the batch, drop the rest.
  let batchKeys = new Set<string>();
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txgioAddress)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          txgioAddress.countyFips,
          txgioAddress.fullAddr,
          txgioAddress.unit,
        ],
        set: {
          objectId: sql`excluded.object_id`,
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
      });
    rowsInserted += batch.length;
    batches += 1;
    batch = [];
    batchKeys = new Set<string>();
    opts.onBatch?.(rowsInserted);
  }

  for await (const rec of records) {
    const key = `${rec.countyFips}|${rec.fullAddr}|${rec.unit}`;
    if (batchKeys.has(key)) continue;
    batchKeys.add(key);
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

  return { rowsInserted, batches };
}
