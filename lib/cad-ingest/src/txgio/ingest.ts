/**
 * Batch load of normalized TxGIO parcel records into `txgio_parcel`.
 *
 * Replace semantics per county: the caller deletes the county's rows
 * first (`deleteCountyParcels`), then streams inserts. Insert batches
 * still carry ON CONFLICT DO UPDATE so a resumed/re-run load after a
 * partial failure is idempotent without a second delete. A feature is
 * inserted once per grid cell its bbox intersects (see `geo.ts`), so
 * `rowsInserted` >= features loaded; `featuresLoaded` counts distinct
 * features.
 *
 * Callers pass a drizzle handle so the CLI (own pool from
 * DATABASE_URL) and tests (`withTestSchema`) share this code — same
 * pattern as `../ingest.ts` (`CadIngestDb`).
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioParcel } from "@workspace/db/schema";
import type { TxgioParcelRecord } from "./parse";

/** Minimal structural slice of a drizzle node-postgres database. */
export type TxgioIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

/**
 * Rows are fat (GeoJSON polygon jsonb), so batches are smaller than
 * the cad_property default of 1000.
 */
export const TXGIO_DEFAULT_BATCH_SIZE = 250;

export async function deleteCountyParcels(
  db: TxgioIngestDb,
  countyFips: string,
): Promise<void> {
  await db
    .delete(txgioParcel)
    .where(sql`${txgioParcel.countyFips} = ${countyFips}`);
}

export interface TxgioUpsertOptions {
  /** Basename recorded on every row. */
  sourceFile: string;
  /** Program vintage label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each batch. */
  onBatch?: (totalRowsInserted: number) => void;
}

export interface TxgioUpsertSummary {
  featuresLoaded: number;
  rowsInserted: number;
  batches: number;
}

export async function upsertTxgioParcels(
  db: TxgioIngestDb,
  records: AsyncIterable<TxgioParcelRecord> | Iterable<TxgioParcelRecord>,
  opts: TxgioUpsertOptions,
): Promise<TxgioUpsertSummary> {
  const batchSize = opts.batchSize ?? TXGIO_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txgioParcel.$inferInsert;
  let batch: InsertRow[] = [];
  let featuresLoaded = 0;
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txgioParcel)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          txgioParcel.countyFips,
          txgioParcel.tileKey,
          txgioParcel.featureIndex,
        ],
        set: {
          propId: sql`excluded.prop_id`,
          geoId: sql`excluded.geo_id`,
          ownerName: sql`excluded.owner_name`,
          situsAddress: sql`excluded.situs_address`,
          situsCity: sql`excluded.situs_city`,
          situsState: sql`excluded.situs_state`,
          situsZip: sql`excluded.situs_zip`,
          geometry: sql`excluded.geometry`,
          westLng: sql`excluded.west_lng`,
          southLat: sql`excluded.south_lat`,
          eastLng: sql`excluded.east_lng`,
          northLat: sql`excluded.north_lat`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      });
    rowsInserted += batch.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsInserted);
  }

  for await (const rec of records) {
    featuresLoaded += 1;
    for (const tileKey of rec.tileKeys) {
      batch.push({
        countyFips: rec.countyFips,
        tileKey,
        featureIndex: rec.featureIndex,
        propId: rec.propId,
        geoId: rec.geoId,
        ownerName: rec.ownerName,
        situsAddress: rec.situsAddress,
        situsCity: rec.situsCity,
        situsState: rec.situsState,
        situsZip: rec.situsZip,
        geometry: rec.geometry as unknown as Record<string, unknown>,
        westLng: rec.bbox.westLng,
        southLat: rec.bbox.southLat,
        eastLng: rec.bbox.eastLng,
        northLat: rec.bbox.northLat,
        sourceFile: opts.sourceFile,
        sourceVintage: opts.sourceVintage,
      });
      if (batch.length >= batchSize) await flush();
    }
  }
  await flush();

  return { featuresLoaded, rowsInserted, batches };
}
