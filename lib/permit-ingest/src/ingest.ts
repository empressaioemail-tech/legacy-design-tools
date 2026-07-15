/**
 * Batch upsert of normalized permit records into `building_permits`.
 *
 * ON CONFLICT (county_fips, prop_id, permit_id) DO UPDATE — re-running
 * an ingest for the same drop (or a fresher drop of the same corpus) is
 * idempotent: attribute columns are overwritten and `ingested_at` is
 * bumped so row age tracks the latest load.
 *
 * Callers pass a drizzle handle so the CLI (own pool from DATABASE_URL)
 * and tests (`withTestSchema`) share this code.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { buildingPermits } from "@workspace/db/schema";
import type { BuildingPermitRecord, UpsertSummary } from "./types";

/**
 * Minimal structural slice of a drizzle node-postgres database — only
 * `insert` is needed, so both the CLI's own handle and the test
 * harness's `withTestSchema` db fit.
 */
export type PermitIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert"
>;

export const DEFAULT_BATCH_SIZE = 1000;

function toInsertRow(
  rec: BuildingPermitRecord,
  sourceFile: string,
  sourceVintage: string,
) {
  return {
    countyFips: rec.countyFips,
    propId: rec.propId,
    permitId: rec.permitId,
    issuedDate: rec.issuedDate,
    appliedDate: rec.appliedDate,
    workClass: rec.workClass,
    status: rec.status,
    description: rec.description,
    permitType: rec.permitType,
    sourceFile,
    sourceVintage,
  };
}

export interface UpsertOptions {
  /** Basename recorded on every row. */
  sourceFile: string;
  /** Export drop label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each batch. */
  onBatch?: (totalUpserted: number) => void;
}

/**
 * Consume `records` and upsert them in batches. The input stream must
 * already be deduplicated on (county_fips, prop_id, permit_id) — the
 * parser guarantees this — because a single INSERT cannot update the
 * same row twice.
 */
export async function upsertBuildingPermits(
  db: PermitIngestDb,
  records: AsyncIterable<BuildingPermitRecord> | Iterable<BuildingPermitRecord>,
  opts: UpsertOptions,
): Promise<UpsertSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let batch: ReturnType<typeof toInsertRow>[] = [];
  let rowsUpserted = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(buildingPermits)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          buildingPermits.countyFips,
          buildingPermits.propId,
          buildingPermits.permitId,
        ],
        set: {
          issuedDate: sql`excluded.issued_date`,
          appliedDate: sql`excluded.applied_date`,
          workClass: sql`excluded.work_class`,
          status: sql`excluded.status`,
          description: sql`excluded.description`,
          permitType: sql`excluded.permit_type`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      });
    rowsUpserted += batch.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsUpserted);
  }

  for await (const rec of records) {
    batch.push(toInsertRow(rec, opts.sourceFile, opts.sourceVintage));
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { rowsUpserted, batches };
}
