/**
 * Batch load of normalized NFHL flood-zone records into
 * `tx_fema_nfhl_flood_zone`.
 *
 * Replace semantics: the caller deletes all rows first, then streams
 * inserts. Insert batches carry ON CONFLICT DO UPDATE so a resumed load
 * after partial failure is idempotent without a second delete.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txFemaNfhlFloodZone } from "@workspace/db/schema";
import type { TxFemaNfhlFloodZoneRecord } from "./parse";

export type NfhlIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

export const NFHL_DEFAULT_BATCH_SIZE = 250;

export interface NfhlSourceMeta {
  source: string;
  sourceVintage: string;
  sourceCitation: string;
}

export interface NfhlUpsertOptions extends NfhlSourceMeta {
  batchSize?: number;
  onBatch?: (totalRowsInserted: number) => void;
}

export interface NfhlUpsertSummary {
  rowsInserted: number;
  batches: number;
}

export async function deleteAllNfhlFloodZones(
  db: NfhlIngestDb,
): Promise<void> {
  await db.delete(txFemaNfhlFloodZone);
}

export async function countAllNfhlFloodZones(
  db: NfhlIngestDb,
): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${txFemaNfhlFloodZone}`,
  )) as unknown as { rows: Array<{ n?: unknown }> };
  const n = result.rows?.[0]?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

export async function upsertNfhlFloodZones(
  db: NfhlIngestDb,
  records:
    | AsyncIterable<TxFemaNfhlFloodZoneRecord>
    | Iterable<TxFemaNfhlFloodZoneRecord>,
  opts: NfhlUpsertOptions,
): Promise<NfhlUpsertSummary> {
  const batchSize = opts.batchSize ?? NFHL_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txFemaNfhlFloodZone.$inferInsert;
  let batch: InsertRow[] = [];
  let batchKeys = new Set<string>();
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txFemaNfhlFloodZone)
      .values(batch)
      .onConflictDoUpdate({
        target: [txFemaNfhlFloodZone.zoneRowId],
        set: {
          dfirmId: sql`excluded.dfirm_id`,
          fldArId: sql`excluded.fld_ar_id`,
          fldZone: sql`excluded.fld_zone`,
          zoneSubty: sql`excluded.zone_subty`,
          sfhaTf: sql`excluded.sfha_tf`,
          staticBfe: sql`excluded.static_bfe`,
          femaObjectId: sql`excluded.fema_object_id`,
          geometry: sql`excluded.geometry`,
          westLng: sql`excluded.west_lng`,
          southLat: sql`excluded.south_lat`,
          eastLng: sql`excluded.east_lng`,
          northLat: sql`excluded.north_lat`,
          source: sql`excluded.source`,
          sourceVintage: sql`excluded.source_vintage`,
          sourceCitation: sql`excluded.source_citation`,
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
    if (batchKeys.has(rec.zoneRowId)) continue;
    batchKeys.add(rec.zoneRowId);
    batch.push({
      zoneRowId: rec.zoneRowId,
      dfirmId: rec.dfirmId,
      fldArId: rec.fldArId,
      fldZone: rec.fldZone,
      zoneSubty: rec.zoneSubty,
      sfhaTf: rec.sfhaTf,
      staticBfe: rec.staticBfe,
      femaObjectId: rec.femaObjectId,
      geometry: rec.geometry,
      westLng: rec.bbox.westLng,
      southLat: rec.bbox.southLat,
      eastLng: rec.bbox.eastLng,
      northLat: rec.bbox.northLat,
      source: opts.source,
      sourceVintage: opts.sourceVintage,
      sourceCitation: opts.sourceCitation,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return { rowsInserted, batches };
}
