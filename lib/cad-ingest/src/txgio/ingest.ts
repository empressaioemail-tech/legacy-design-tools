/**
 * Batch load of normalized TxGIO parcel records into `txgio_parcel`.
 *
 * Replace semantics per county: `replaceCountyParcels` deletes the
 * county's rows and streams the new ones IN ONE TRANSACTION, so a
 * mid-county failure — a projection error on feature 900, a dropped
 * connection, an OOM — can never leave a county deleted with nothing
 * loaded. Before 2026-08-08 the delete ran outside any transaction and
 * that window was real; the statewide sweep made mid-county failure a
 * realistic outcome rather than a hypothetical one, since 57 counties
 * ship coordinates the parser now (correctly) refuses.
 *
 * Insert batches still carry ON CONFLICT DO UPDATE so a resumed load
 * after a partial failure is idempotent without a second delete, and so
 * two features sharing a (county, tileKey, featureIndex) key cannot
 * duplicate. A feature is inserted once per grid cell its bbox
 * intersects (see `geo.ts`), so `rowsInserted` >= features loaded;
 * `featuresLoaded` counts distinct features.
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
 * A handle that can open a transaction. The CLI's pooled drizzle
 * instance and `withTestSchema`'s test handle both satisfy it; the
 * callback receives a `TxgioIngestDb`-shaped transaction handle.
 */
export interface TxgioTransactionalDb extends TxgioIngestDb {
  transaction<T>(fn: (tx: TxgioIngestDb) => Promise<T>): Promise<T>;
}

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

/**
 * Rows currently stored for a county. Used by the dry run to predict
 * how many rows an apply would DELETE, so a dry/apply pair is
 * comparable rather than a bare "0 (dry-run)".
 */
export async function countCountyParcels(
  db: TxgioIngestDb,
  countyFips: string,
): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${txgioParcel}
        WHERE ${txgioParcel.countyFips} = ${countyFips}`,
  )) as unknown as { rows: Array<{ n?: unknown }> };
  const n = result.rows?.[0]?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

/**
 * Distinct county FIPS that currently have at least one row in
 * `txgio_parcel`. This is store truth for CLI `--list` LOADED state —
 * not the hand-maintained `TXGIO_COUNTIES` map (that map remains for
 * `jurisdictions.ts` geometry composition only).
 */
export async function listLoadedCountyFips(
  db: TxgioIngestDb,
): Promise<string[]> {
  const result = (await db.execute(
    sql`SELECT DISTINCT ${txgioParcel.countyFips} AS fips FROM ${txgioParcel}
        ORDER BY 1`,
  )) as unknown as { rows: Array<{ fips?: unknown }> };
  return (result.rows ?? [])
    .map((r) => String(r.fips ?? "").trim())
    .filter((f) => f.length > 0);
}

/**
 * Store-derived "loaded before" summary label for the ingest CLI.
 * `rowsExisting` comes from `countCountyParcels`; `null` means the dry
 * run had no DATABASE_URL and could not observe the store.
 */
export function storeLoadedLabel(rowsExisting: number | null): string {
  if (rowsExisting === null) return "unknown (no DATABASE_URL)";
  return rowsExisting > 0 ? "yes" : "no";
}

/**
 * Per-county `--list` load state from store observation.
 * `loadedFips === null` means DATABASE_URL was absent — never pretend
 * the hand map is store truth; label UNKNOWN instead.
 */
export function storeListLoadState(
  fips: string,
  loadedFips: ReadonlySet<string> | null,
  absentFromStratmap: boolean,
): "ABSENT" | "LOADED" | "UNKNOWN" | "-     " {
  if (absentFromStratmap) return "ABSENT";
  if (loadedFips === null) return "UNKNOWN";
  return loadedFips.has(fips) ? "LOADED" : "-     ";
}

/**
 * Provenance suffix appended to `source_vintage` on every row whose
 * geometry was converted from a projected source CRS.
 *
 * `source_vintage` is a free-text program label carried opaquely all the
 * way out to the parcel feature the map serves
 * (`artifacts/api-server/src/lib/txgioParcelStore.ts` copies it into
 * `properties.sourceVintage`; nothing anywhere parses or pattern-matches
 * it). That makes it the natural home for this marker and means NO
 * MIGRATION is required: a reprojected King county row reads
 * `stratmap25-landparcels_48269_king_202505+reprojected-from-epsg3857`,
 * which is self-describing at every layer including the served feature,
 * and is queryable with a LIKE if we ever need to find or re-run the
 * converted counties.
 *
 * A dedicated `source_crs` column would be tidier in the abstract, and
 * if a future need arises to filter on it in bulk that is the right
 * shape — but it is a schema migration plus a backfill for a fact that
 * the existing free-text provenance field already carries losslessly, so
 * it is not justified today.
 */
export const REPROJECTED_VINTAGE_SUFFIX = "+reprojected-from-epsg3857";

/**
 * Vintage label for a run, carrying the reprojection marker when the
 * geometry was converted. Pure, so the CLI summary and the stored rows
 * cannot disagree about what was recorded.
 */
export function vintageWithProvenance(
  vintage: string,
  reprojectedFrom?: string,
): string {
  if (!reprojectedFrom) return vintage;
  return `${vintage}${REPROJECTED_VINTAGE_SUFFIX}`;
}

export interface TxgioUpsertOptions {
  /** Basename recorded on every row. */
  sourceFile: string;
  /**
   * Program vintage label recorded on every row. Callers that
   * reprojected must pass the label through `vintageWithProvenance` so
   * the conversion is recorded on the row.
   */
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

/**
 * PARCEL-TXGIO-REACQ found this live: `geom` (a PostGIS `geometry(Geometry,4326)`
 * column with its own partial GiST index, `txgio_parcel_geom_gist_idx`) carries
 * zero triggers and no generated-column expression -- it was populated ENTIRELY by
 * a separate, uncodified manual backfill, never by this ingest code. Because
 * `replaceCountyParcels` deletes-then-inserts a county atomically, every apply
 * silently wiped `geom` back to NULL for every county it touched, not only the
 * ones (Caldwell) that already started NULL -- this is the TXGIO-GEOM-FIX card.
 *
 * This is the exact formula the reacq close's own manual backfill already
 * validated live across all six program counties (Caldwell: 32781/32781 valid;
 * Travis: 894657/894657 valid). Kept as a raw UPDATE rather than a value expressed
 * inline in the drizzle `.values()` insert: `geometry` is a jsonb column already
 * proven to round-trip correctly through drizzle's typed insert, and this way the
 * SAME derivation runs unconditionally after every batch regardless of whether
 * that batch's rows were fresh inserts or ON CONFLICT updates -- "geom written at
 * insert AND updated on conflict" is satisfied by construction, not by having to
 * keep two code paths in sync.
 */
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

    // `sql.param(...)`, not plain `${...}` interpolation: drizzle's default
    // array interpolation SPREADS a JS array into one placeholder per
    // element ($1, $2, ...) for IN-clause convenience, which is not what
    // `unnest` needs -- `sql.param` forces a single bound parameter and lets
    // node-postgres's own array serialization produce a real `{...}` literal.
    const countyFipsKeys = sql.param(batch.map((r) => r.countyFips));
    const tileKeys = sql.param(batch.map((r) => r.tileKey));
    const featureIndexKeys = sql.param(batch.map((r) => r.featureIndex));
    await db.execute(sql`
      UPDATE ${txgioParcel} AS t
         SET geom = ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(t.geometry::text), 4326))
        FROM unnest(${countyFipsKeys}::text[], ${tileKeys}::text[], ${featureIndexKeys}::int[])
          AS v(county_fips, tile_key, feature_index)
       WHERE t.county_fips = v.county_fips
         AND t.tile_key = v.tile_key
         AND t.feature_index = v.feature_index
    `);

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

export interface TxgioReplaceSummary extends TxgioUpsertSummary {
  /** Rows the county held before the replace (all deleted). */
  rowsDeleted: number;
}

/**
 * Replace one county's parcel rows ATOMICALLY: delete the county's
 * existing rows and stream the new ones inside a single transaction.
 *
 * This is the write path the CLI uses, and the transaction is the whole
 * point. Delete-then-load outside a transaction leaves a window in
 * which a county is deleted with nothing loaded — a county that dies on
 * feature 900 of 30,000 ends up EMPTY rather than merely stale, which
 * is strictly worse than not having run at all. With the transaction, a
 * throw anywhere in parse or insert rolls the delete back and the
 * county keeps its previous vintage.
 *
 * Note the parse work happens lazily inside the transaction, since
 * `records` is consumed by `upsertTxgioParcels`. That is deliberate: a
 * projection error raised by `normalizeTxgioFeature` mid-stream must
 * roll back the delete, so it has to be inside the transaction
 * boundary, not before it.
 */
export async function replaceCountyParcels(
  db: TxgioTransactionalDb,
  countyFips: string,
  records: AsyncIterable<TxgioParcelRecord> | Iterable<TxgioParcelRecord>,
  opts: TxgioUpsertOptions,
): Promise<TxgioReplaceSummary> {
  return await db.transaction(async (tx) => {
    const rowsDeleted = await countCountyParcels(tx, countyFips);
    await deleteCountyParcels(tx, countyFips);
    const summary = await upsertTxgioParcels(tx, records, opts);
    return { ...summary, rowsDeleted };
  });
}
