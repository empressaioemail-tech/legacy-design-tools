/**
 * DB side of the parcel zoning stamp (F11): read a county's distinct
 * parcels out of `txgio_parcel`, point-in-polygon each against the
 * in-memory zoning index, and UPDATE `zoning_district` on the matched rows.
 *
 * Rows in `txgio_parcel` are duplicated one-per-grid-cell (see geo.ts), so
 * a parcel's identity across cells is `(county_fips, feature_index)`. We
 * read DISTINCT features (geometry is identical across a feature's cells),
 * stamp each, and UPDATE every row of that feature so the served feature
 * (any cell) carries the code. Additive: only `zoning_district` is written;
 * geometry/owner/situs are untouched. Idempotent: a re-run recomputes and
 * overwrites in place. A parcel whose centroid falls in no zoning polygon
 * is left NULL (never guessed).
 *
 * db-handle-injected (own pool from the CLI; a fake in tests), same pattern
 * as `ingest.ts`.
 */

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioParcel } from "@workspace/db/schema";
import type { GeoJsonGeometry } from "./geo";
import { stampParcelZoning, type ZoningPolygon } from "./zoning-stamp";

export type ZoningStampDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "selectDistinctOn" | "update"
>;

export interface ZoningStampSummary {
  /** Distinct parcels (feature_index values) read for the county. */
  parcelsRead: number;
  /** Parcels whose centroid matched a zoning polygon. */
  parcelsMatched: number;
  /** Parcels left NULL (centroid in no zoning polygon). */
  parcelsUnmatched: number;
  /** Distinct district codes stamped, with counts (for the audit log). */
  codeHistogram: Record<string, number>;
  /** Total txgio_parcel ROWS updated (>= parcelsMatched; per-cell dupes). */
  rowsUpdated: number;
}

interface DistinctParcelRow {
  featureIndex: number;
  geometry: unknown;
}

/**
 * Stamp one county's parcels from the zoning index. When `dryRun`, does the
 * PIP + histogram but writes nothing (still exit-bounded). `onProgress`
 * fires every `progressEvery` parcels.
 */
export async function stampCountyZoning(opts: {
  db: ZoningStampDb;
  countyFips: string;
  index: ZoningPolygon[];
  dryRun?: boolean;
  limit?: number;
  onProgress?: (done: number, matched: number) => void;
  progressEvery?: number;
}): Promise<ZoningStampSummary> {
  const { db, countyFips, index, dryRun, limit } = opts;
  const progressEvery = opts.progressEvery ?? 5000;

  // Distinct features for the county (geometry identical across a feature's
  // per-cell duplicate rows), keyed by feature_index.
  const parcels = (await db
    .selectDistinctOn([txgioParcel.featureIndex], {
      featureIndex: txgioParcel.featureIndex,
      geometry: txgioParcel.geometry,
    })
    .from(txgioParcel)
    .where(eq(txgioParcel.countyFips, countyFips))
    .orderBy(txgioParcel.featureIndex)) as DistinctParcelRow[];

  const summary: ZoningStampSummary = {
    parcelsRead: 0,
    parcelsMatched: 0,
    parcelsUnmatched: 0,
    codeHistogram: {},
    rowsUpdated: 0,
  };

  for (const p of parcels) {
    if (limit !== undefined && summary.parcelsRead >= limit) break;
    summary.parcelsRead += 1;
    const hit = stampParcelZoning(index, p.geometry as GeoJsonGeometry);
    if (!hit) {
      summary.parcelsUnmatched += 1;
    } else {
      summary.parcelsMatched += 1;
      summary.codeHistogram[hit.code] =
        (summary.codeHistogram[hit.code] ?? 0) + 1;
      if (!dryRun) {
        const res = (await db
          .update(txgioParcel)
          .set({ zoningDistrict: hit.code })
          .where(
            and(
              eq(txgioParcel.countyFips, countyFips),
              eq(txgioParcel.featureIndex, p.featureIndex),
            ),
          )) as unknown as { rowCount?: number };
        summary.rowsUpdated += res?.rowCount ?? 0;
      }
    }
    if (summary.parcelsRead % progressEvery === 0) {
      opts.onProgress?.(summary.parcelsRead, summary.parcelsMatched);
    }
  }

  return summary;
}

/** Exposed for the CLI's row-count clarity. */
export const __zoningStampInternal = { sql };
