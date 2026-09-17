/**
 * Batch load of normalized ETJ rings and per-publisher source rows into
 * `tx_etj_boundary` and `tx_etj_source`
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Mirrors `boundary/ingest.ts`: replace semantics per publisher (the caller
 * deletes that publisher's rows first), then batched inserts carrying
 * ON CONFLICT DO UPDATE so a resumed run after partial failure is idempotent
 * without a second delete.
 *
 * Replace is PER PUBLISHER, not wholesale: an operator refreshing Austin must
 * not silently drop San Antonio's rings. `deleteEtjBoundariesForSource` takes
 * the city keys being re-acquired; the source row is keyed by cityKey and is
 * upserted in place, so a city that publishes no ETJ rings still lands a row
 * with `has_etj_rings=false` and the enumeration outcome recorded.
 */

import { inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txEtjBoundary, txEtjSource } from "@workspace/db/schema";
import type { TxEtjBoundaryRecord } from "./etjParse";

export type EtjIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

export const ETJ_DEFAULT_BATCH_SIZE = 100;

export interface EtjSourceRowMeta {
  cityKey: string;
  cityName: string;
  cityGeoId: string | null;
  mode: string;
  layerUrl: string | null;
  layerName: string | null;
  hasEtjRings: boolean;
  bbox: {
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  } | null;
  etjRingCount: number;
  layerLastEditAt: string | null;
  sourceVintage: string;
  sourceCitation: string;
}

export interface EtjUpsertOptions {
  source: string;
  sourceVintage: string;
  batchSize?: number;
  onBatch?: (totalRowsInserted: number) => void;
}

export interface EtjUpsertSummary {
  rowsInserted: number;
  batches: number;
}

/** Delete the rings of exactly the publishers about to be re-acquired. */
export async function deleteEtjBoundariesForSources(
  db: EtjIngestDb,
  cityKeys: readonly string[],
): Promise<void> {
  if (cityKeys.length === 0) return;
  await db.delete(txEtjBoundary).where(inArray(txEtjBoundary.cityKey, [...cityKeys]));
}

export async function upsertEtjBoundaries(
  db: EtjIngestDb,
  records:
    | AsyncIterable<TxEtjBoundaryRecord>
    | Iterable<TxEtjBoundaryRecord>,
  opts: EtjUpsertOptions,
): Promise<EtjUpsertSummary> {
  const batchSize = opts.batchSize ?? ETJ_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txEtjBoundary.$inferInsert;
  let batch: InsertRow[] = [];
  let batchKeys = new Set<string>();
  let rowsInserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(txEtjBoundary)
      .values(batch)
      .onConflictDoUpdate({
        target: [txEtjBoundary.etjId],
        set: {
          cityKey: sql`excluded.city_key`,
          cityName: sql`excluded.city_name`,
          cityGeoId: sql`excluded.city_geo_id`,
          ringLabel: sql`excluded.ring_label`,
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
    if (batchKeys.has(rec.etjId)) continue;
    batchKeys.add(rec.etjId);
    batch.push({
      etjId: rec.etjId,
      cityKey: rec.cityKey,
      cityName: rec.cityName,
      cityGeoId: rec.cityGeoId,
      ringLabel: rec.ringLabel,
      geometry: rec.geometry,
      westLng: rec.bbox.westLng,
      southLat: rec.bbox.southLat,
      eastLng: rec.bbox.eastLng,
      northLat: rec.bbox.northLat,
      source: opts.source,
      sourceVintage: opts.sourceVintage,
      sourceCitation: rec.sourceCitation,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return { rowsInserted, batches };
}

/**
 * Upsert the per-publisher source rows. One row per register entry, including
 * the cities that publish no ETJ layer, so the read path can tell a checked
 * "this city publishes no ETJ" from a city nobody enumerated.
 */
export async function upsertEtjSources(
  db: EtjIngestDb,
  rows: readonly EtjSourceRowMeta[],
): Promise<number> {
  if (rows.length === 0) return 0;
  type InsertRow = typeof txEtjSource.$inferInsert;
  const values: InsertRow[] = rows.map((r) => ({
    cityKey: r.cityKey,
    cityName: r.cityName,
    cityGeoId: r.cityGeoId,
    mode: r.mode,
    layerUrl: r.layerUrl,
    layerName: r.layerName,
    hasEtjRings: r.hasEtjRings,
    westLng: r.bbox?.westLng ?? null,
    southLat: r.bbox?.southLat ?? null,
    eastLng: r.bbox?.eastLng ?? null,
    northLat: r.bbox?.northLat ?? null,
    etjRingCount: r.etjRingCount,
    layerLastEditAt: r.layerLastEditAt ? new Date(r.layerLastEditAt) : null,
    sourceVintage: r.sourceVintage,
    sourceCitation: r.sourceCitation,
  }));
  await db
    .insert(txEtjSource)
    .values(values)
    .onConflictDoUpdate({
      target: [txEtjSource.cityKey],
      set: {
        cityName: sql`excluded.city_name`,
        cityGeoId: sql`excluded.city_geo_id`,
        mode: sql`excluded.mode`,
        layerUrl: sql`excluded.layer_url`,
        layerName: sql`excluded.layer_name`,
        hasEtjRings: sql`excluded.has_etj_rings`,
        westLng: sql`excluded.west_lng`,
        southLat: sql`excluded.south_lat`,
        eastLng: sql`excluded.east_lng`,
        northLat: sql`excluded.north_lat`,
        etjRingCount: sql`excluded.etj_ring_count`,
        layerLastEditAt: sql`excluded.layer_last_edit_at`,
        sourceVintage: sql`excluded.source_vintage`,
        sourceCitation: sql`excluded.source_citation`,
        ingestedAt: sql`now()`,
      },
    });
  return values.length;
}
