/**
 * Batch load of normalized boundary records into `tx_city_boundary` and
 * `tx_county_boundary`.
 *
 * Replace semantics per layer: the caller deletes all rows for the layer
 * first, then streams inserts. Insert batches carry ON CONFLICT DO UPDATE so
 * a resumed load after partial failure is idempotent without a second delete.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txCityBoundary, txCountyBoundary } from "@workspace/db/schema";
import type {
  TxCityBoundaryRecord,
  TxCountyBoundaryRecord,
} from "./parse";

export type BoundaryIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

export const BOUNDARY_DEFAULT_BATCH_SIZE = 100;

export interface BoundarySourceMeta {
  source: string;
  sourceVintage: string;
  sourceCitation: string;
}

export interface BoundaryUpsertOptions extends BoundarySourceMeta {
  batchSize?: number;
  onBatch?: (totalRowsInserted: number) => void;
}

export interface BoundaryUpsertSummary {
  rowsInserted: number;
  batches: number;
}

export async function deleteAllCityBoundaries(
  db: BoundaryIngestDb,
): Promise<void> {
  await db.delete(txCityBoundary);
}

export async function deleteAllCountyBoundaries(
  db: BoundaryIngestDb,
): Promise<void> {
  await db.delete(txCountyBoundary);
}

export async function upsertCityBoundaries(
  db: BoundaryIngestDb,
  records:
    | AsyncIterable<TxCityBoundaryRecord>
    | Iterable<TxCityBoundaryRecord>,
  opts: BoundaryUpsertOptions,
): Promise<BoundaryUpsertSummary> {
  const batchSize = opts.batchSize ?? BOUNDARY_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txCityBoundary.$inferInsert;
  let batch: InsertRow[] = [];
  let batchKeys = new Set<string>();
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txCityBoundary)
      .values(batch)
      .onConflictDoUpdate({
        target: [txCityBoundary.geoId],
        set: {
          cityName: sql`excluded.city_name`,
          gnis: sql`excluded.gnis`,
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
    if (batchKeys.has(rec.geoId)) continue;
    batchKeys.add(rec.geoId);
    batch.push({
      geoId: rec.geoId,
      cityName: rec.cityName,
      gnis: rec.gnis,
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

export async function upsertCountyBoundaries(
  db: BoundaryIngestDb,
  records:
    | AsyncIterable<TxCountyBoundaryRecord>
    | Iterable<TxCountyBoundaryRecord>,
  opts: BoundaryUpsertOptions,
): Promise<BoundaryUpsertSummary> {
  const batchSize = opts.batchSize ?? BOUNDARY_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txCountyBoundary.$inferInsert;
  let batch: InsertRow[] = [];
  let batchKeys = new Set<string>();
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txCountyBoundary)
      .values(batch)
      .onConflictDoUpdate({
        target: [txCountyBoundary.countyFips],
        set: {
          countyName: sql`excluded.county_name`,
          stateFips: sql`excluded.state_fips`,
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
    if (batchKeys.has(rec.countyFips)) continue;
    batchKeys.add(rec.countyFips);
    batch.push({
      countyFips: rec.countyFips,
      countyName: rec.countyName,
      stateFips: rec.stateFips,
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
