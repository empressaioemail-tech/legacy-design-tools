/**
 * DB side of the parcel zoning stamp (F11): read a county's distinct
 * parcels out of `txgio_parcel`, point-in-polygon each against the
 * in-memory zoning index, and UPDATE `zoning_district` +
 * `zoning_jurisdiction` on the matched rows.
 *
 * Rows in `txgio_parcel` are duplicated one-per-grid-cell (see geo.ts), so
 * a parcel's identity across cells is `(county_fips, feature_index)`. We
 * read DISTINCT features (geometry is identical across a feature's cells),
 * stamp each, and UPDATE every row of that feature so the served feature
 * (any cell) carries the code. Additive: only zoning columns are written;
 * geometry/owner/situs are untouched. Idempotent: a re-run recomputes and
 * overwrites in place. A parcel whose centroid falls in no zoning polygon
 * is left NULL (never guessed).
 *
 * `zoning_jurisdiction` is the ZONING_LAYERS cityKey of the layer being
 * stamped (PIP membership is authoritative for multi-city counties).
 *
 * Every parcel lands in exactly ONE of four buckets (P-259), and the four sum
 * to `parcelsRead` — a parcel cannot be silently dropped, and no bucket can
 * grow by shrinking another:
 *   parcelsMatched            a resolved BASE district was written
 *   parcelsPlannedDevelopment a PUD/PDD/PD/PC value, written RAW so A-164's
 *                             PUD message fires on it
 *   parcelsUnrecognised       a published value with no base district in this
 *                             city's vocabulary, written RAW (the router has a
 *                             named decline path for a code it cannot resolve;
 *                             NULL would assert "no zoning on record") and
 *                             listed in `unrecognisedHistogram`
 *   parcelsUnmatched          no zoning polygon holds the representative point
 *                             (outside the city, or an un-zoned pocket)
 * The split between the last two is the point: "outside the city" and "in a
 * district this vocabulary does not carry" are different facts, and only the
 * second is work owed.
 *
 * Write path: progressive flush every ZONING_STAMP_BATCH_SIZE matches so a
 * long county run cannot lose the stamp if the process dies mid-PIP.
 *
 * db-handle-injected (own pool from the CLI; a fake in tests), same pattern
 * as `ingest.ts`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioParcel } from "@workspace/db/schema";
import type { GeoJsonGeometry } from "./geo";
import type { BaseCodeKind } from "./zoning-base-code";
import { stampParcelZoning, type ZoningPolygon } from "./zoning-stamp";

/**
 * Injected db handle. Reads use `selectDistinctOn`; the batched write uses
 * raw `execute(sql...)` (drizzle's typed `.update()` builder can't express a
 * `VALUES`-join set-update cleanly), so `execute` is part of the surface the
 * CLI's real pool and the test fake both satisfy.
 */
export type ZoningStampDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "selectDistinctOn" | "execute"
>;

export interface ZoningStampSummary {
  /** Distinct parcels (feature_index values) read for the county. */
  parcelsRead: number;
  /** Parcels whose representative point matched a stampable zoning polygon. */
  parcelsMatched: number;
  /** Parcels left NULL (representative point in no zoning polygon). */
  parcelsUnmatched: number;
  /**
   * Parcels whose polygon published a value with no base district in this
   * city's vocabulary (P-259). The published value is stamped VERBATIM — never
   * a truncated prefix — and the parcel is counted here rather than in
   * `parcelsMatched` so a base-district count is never inflated by it.
   * `unrecognisedHistogram` lists every such value with its parcel count.
   */
  parcelsUnrecognised: number;
  /**
   * Parcels stamped with a PLANNED-DEVELOPMENT value (PUD/PDD/PD/PC), stamped
   * RAW so A-164's "your setbacks come from your PUD ordinance" message fires.
   * Counted apart from `parcelsMatched` so a base-district count is never
   * inflated by parcels whose setbacks are not in the table's gift.
   */
  parcelsPlannedDevelopment: number;
  /** Distinct district codes stamped, with counts (for the audit log). */
  codeHistogram: Record<string, number>;
  /**
   * Published values that could not be resolved to a base district, with the
   * number of parcels in each (P-259). Every value is listed, never sampled —
   * this is the acquisition worklist the row exists to produce.
   */
  unrecognisedHistogram: Record<string, number>;
  /**
   * Overlay/combining suffixes seen on stamped parcels, with counts (P-259).
   * Counted for RESOLVED base districts only: those are the values where the
   * parser can prove which tokens are the base and which are the suffix. A
   * planned-development or unrecognised value is stamped raw without its tokens
   * being classified, so counting those as overlays would report the district
   * inside "I-SF-2" as an overlay.
   */
  overlayHistogram: Record<string, number>;
  /**
   * Total txgio_parcel ROWS updated (>= parcelsMatched; per-cell dupes).
   * Every STAMPED parcel counts here — matched, planned-development and
   * unrecognised alike — since all three write a code.
   */
  rowsUpdated: number;
  /**
   * Scoped runs only (`propIds` supplied): size of the requested prop-id
   * list (post-dedupe). Undefined on an unscoped (whole-county) run.
   */
  listSize?: number;
  /**
   * Scoped runs only: how many of `listSize` resolved to at least one
   * `txgio_parcel` row for this county (i.e. `parcelsRead` in scoped mode).
   * Named separately from `parcelsRead` so a caller reading the summary
   * does not have to infer "matched the list" from the generic field.
   */
  matched?: number;
  /**
   * Scoped runs only: requested prop ids with ZERO rows in `txgio_parcel`
   * for this county (never guessed, never silently dropped).
   */
  notFoundInParcelStore?: string[];
  /**
   * Scoped runs only: requested prop ids that resolved to a parcel row but
   * whose centroid matched no zoning polygon (subset semantics identical
   * to the whole-county `parcelsUnmatched`, but named for the scoped
   * caller so nothing is silent).
   */
  noZoningPolygonHit?: string[];
  /**
   * Scoped runs only: requested prop ids whose parcel landed in a polygon
   * whose published value carries no base district (P-259). A subset of the
   * resolved parcels, disjoint from `noZoningPolygonHit` — the parcel IS in a
   * zoning polygon, the vocabulary just does not carry it.
   */
  unrecognisedPropIds?: string[];
  /**
   * Scoped runs only: one row per resolved parcel with its PIP outcome —
   * the per-parcel would-stamp table (dry-run) or applied table (live).
   * `district` is null when nothing is stamped, and `kind` says why:
   * `none` (no zoning polygon), `unrecognised` (published value has no base in
   * this city's vocabulary), `base`, or `planned-development` (stamped raw).
   * `publishedCode` is the value the layer published for that polygon.
   */
  perParcel?: {
    propId: string;
    featureIndex: number;
    district: string | null;
    kind: BaseCodeKind | "none";
    publishedCode?: string | null;
  }[];
}

interface DistinctParcelRow {
  featureIndex: number;
  geometry: unknown;
  /** Only selected in scoped mode (propIds supplied); undefined otherwise. */
  propId?: string | null;
}

/** One matched parcel's stamp, collected during PIP, flushed in batches. */
interface StampPair {
  featureIndex: number;
  code: string;
}

/**
 * Max `(feature_index, code, jurisdiction)` triples per batched UPDATE.
 * Each triple binds 3 params and the whole statement binds 1 shared county
 * param, so a batch of 5000 binds 15001 params — well under pg's ~65535
 * bound-parameter ceiling. Exported for the test that proves the chunk split.
 */
export const ZONING_STAMP_BATCH_SIZE = 5000;

/** Split a flat array into fixed-size chunks (last chunk may be short). */
export function chunkPairs<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Flush one batch of matched pairs as a single set-based UPDATE joining a
 * parameterized `VALUES` list. Returns the number of ROWS updated (sums all
 * per-cell duplicate rows of every feature in the batch). All values are
 * bound params (never interpolated), so the code strings are injection-safe.
 */
async function flushBatch(
  db: ZoningStampDb,
  countyFips: string,
  cityKey: string,
  batch: StampPair[],
): Promise<number> {
  if (batch.length === 0) return 0;
  // (feature_index, code, jurisdiction) tuples as bound params.
  const values = sql.join(
    batch.map(
      (p) =>
        sql`(${p.featureIndex}::integer, ${p.code}::text, ${cityKey}::text)`,
    ),
    sql`, `,
  );
  const stmt = sql`
    UPDATE ${txgioParcel} AS t
    SET zoning_district = v.code,
        zoning_jurisdiction = v.jurisdiction
    FROM (VALUES ${values}) AS v(feature_index, code, jurisdiction)
    WHERE t.county_fips = ${countyFips}
      AND t.feature_index = v.feature_index
  `;
  const res = (await db.execute(stmt)) as unknown as { rowCount?: number };
  return res?.rowCount ?? 0;
}

/**
 * Stamp one county's parcels from the zoning index. When `dryRun`, does the
 * PIP + histogram but writes nothing (still exit-bounded). `onProgress`
 * fires every `progressEvery` parcels. `cityKey` is persisted as
 * `zoning_jurisdiction` on every match (the layer that owned the PIP).
 */
export async function stampCountyZoning(opts: {
  db: ZoningStampDb;
  countyFips: string;
  /** ZONING_LAYERS cityKey for this stamp run (e.g. `austin-tx`). */
  cityKey: string;
  index: ZoningPolygon[];
  dryRun?: boolean;
  limit?: number;
  /**
   * Scoped mode: when supplied, the parcel READ is restricted to rows
   * whose `prop_id` is in this set (`WHERE county_fips = ... AND prop_id =
   * ANY(...)`), the PIP/stamp logic runs unchanged over exactly those
   * rows, and the UPDATE naturally stays scoped because it only ever
   * targets `(county_fips, feature_index)` pairs produced by the filtered
   * read. Values must already be normalized (leading-zero-stripped) — the
   * caller (CLI) owns normalization so this function stays a pure DB/PIP
   * layer. Composes with `dryRun`; ignored together with `limit` is
   * pointless but not rejected (limit still applies on top of the
   * filtered set, in read order).
   */
  propIds?: Set<string>;
  onProgress?: (done: number, matched: number) => void;
  progressEvery?: number;
}): Promise<ZoningStampSummary> {
  const { db, countyFips, cityKey, index, dryRun, limit, propIds } = opts;
  const progressEvery = opts.progressEvery ?? 5000;
  if (!cityKey.trim()) {
    throw new Error("stampCountyZoning requires cityKey (ZONING_LAYERS key)");
  }

  const scoped = propIds !== undefined && propIds.size > 0;

  // Distinct features for the county (geometry identical across a feature's
  // per-cell duplicate rows), keyed by feature_index. Scoped mode adds a
  // prop_id = ANY(...) filter on the same read and also selects prop_id so
  // we can report which requested ids resolved to a row.
  const whereClause = scoped
    ? and(
        eq(txgioParcel.countyFips, countyFips),
        inArray(txgioParcel.propId, [...propIds]),
      )
    : eq(txgioParcel.countyFips, countyFips);

  const parcels = (await db
    .selectDistinctOn([txgioParcel.featureIndex], {
      featureIndex: txgioParcel.featureIndex,
      geometry: txgioParcel.geometry,
      propId: txgioParcel.propId,
    })
    .from(txgioParcel)
    .where(whereClause)
    .orderBy(txgioParcel.featureIndex)) as DistinctParcelRow[];

  const summary: ZoningStampSummary = {
    parcelsRead: 0,
    parcelsMatched: 0,
    parcelsUnmatched: 0,
    parcelsUnrecognised: 0,
    parcelsPlannedDevelopment: 0,
    codeHistogram: {},
    unrecognisedHistogram: {},
    overlayHistogram: {},
    rowsUpdated: 0,
  };

  const noZoningPolygonHit: string[] = [];
  const unrecognisedPropIds: string[] = [];
  const foundPropIds = new Set<string>();
  const perParcel: NonNullable<ZoningStampSummary["perParcel"]> = [];
  const bump = (hist: Record<string, number>, key: string): void => {
    hist[key] = (hist[key] ?? 0) + 1;
  };

  // PIP loop: collect matched pairs and flush in batches as we go so a
  // long county run (Bexar ~700k parcels / ~400k matches) cannot lose the
  // entire stamp if the process dies after PIP but before a single end-of-
  // run write. dryRun collects for the histogram only and writes nothing.
  const matches: StampPair[] = [];
  let rowsUpdated = 0;
  for (const p of parcels) {
    if (limit !== undefined && summary.parcelsRead >= limit) break;
    summary.parcelsRead += 1;
    if (scoped && p.propId) foundPropIds.add(p.propId);
    const hit = stampParcelZoning(index, p.geometry as GeoJsonGeometry);
    if (!hit) {
      // No zoning polygon holds the parcel's representative point: outside the
      // city, or an un-zoned pocket. Honest null, never a guessed district.
      summary.parcelsUnmatched += 1;
      if (scoped && p.propId) {
        noZoningPolygonHit.push(p.propId);
        perParcel.push({
          propId: p.propId,
          featureIndex: p.featureIndex,
          district: null,
          kind: "none",
        });
      }
    } else if (hit.parse?.kind === "unrecognised") {
      // In a polygon whose published value carries no base district in this
      // city's vocabulary (Austin: the interim I-* family, the overlay families
      // TOD/NBG/ERC/TND/UNZ, anything else the table does not name). The
      // PUBLISHED value is written verbatim — it is a real fact about the
      // parcel, and the router has a designed path for a code it cannot resolve
      // (mapDistrict returns null -> the callers decline with a named reason)
      // whereas dropping it to NULL would assert "no zoning on record", which is
      // false. What is never written is a TRUNCATED prefix: for
      // "CS-1-MU-..." that would be CS, a different district with a different
      // row. Counted apart so a base-district count is never inflated.
      summary.parcelsUnrecognised += 1;
      bump(summary.unrecognisedHistogram, hit.code);
      matches.push({ featureIndex: p.featureIndex, code: hit.code });
      if (scoped && p.propId) {
        unrecognisedPropIds.push(p.propId);
        perParcel.push({
          propId: p.propId,
          featureIndex: p.featureIndex,
          district: hit.code,
          kind: "unrecognised",
          publishedCode: hit.code,
        });
      }
      if (!dryRun && matches.length >= ZONING_STAMP_BATCH_SIZE) {
        rowsUpdated += await flushBatch(db, countyFips, cityKey, matches);
        matches.length = 0;
      }
    } else {
      const kind = hit.parse?.kind ?? "base";
      if (kind === "planned-development") summary.parcelsPlannedDevelopment += 1;
      else summary.parcelsMatched += 1;
      bump(summary.codeHistogram, hit.code);
      // Overlays only for a RESOLVED base: with kind "base" the parser has
      // proven which tokens are the base and which are the suffix. A
      // planned-development value's tokens are not classified (the stamp
      // writes it raw), so they are left out rather than reported as overlays.
      if (kind === "base") {
        for (const overlay of hit.parse?.overlays ?? []) {
          bump(summary.overlayHistogram, overlay);
        }
      }
      matches.push({ featureIndex: p.featureIndex, code: hit.code });
      if (scoped && p.propId) {
        perParcel.push({
          propId: p.propId,
          featureIndex: p.featureIndex,
          district: hit.code,
          kind,
          publishedCode: hit.parse?.raw ?? hit.code,
        });
      }
      if (!dryRun && matches.length >= ZONING_STAMP_BATCH_SIZE) {
        rowsUpdated += await flushBatch(db, countyFips, cityKey, matches);
        matches.length = 0;
      }
    }
    if (summary.parcelsRead % progressEvery === 0) {
      opts.onProgress?.(summary.parcelsRead, summary.parcelsMatched);
    }
  }

  if (!dryRun && matches.length > 0) {
    rowsUpdated += await flushBatch(db, countyFips, cityKey, matches);
  }
  summary.rowsUpdated = rowsUpdated;

  if (scoped) {
    summary.listSize = propIds!.size;
    summary.matched = foundPropIds.size;
    summary.notFoundInParcelStore = [...propIds!].filter(
      (id) => !foundPropIds.has(id),
    );
    summary.noZoningPolygonHit = noZoningPolygonHit;
    summary.unrecognisedPropIds = unrecognisedPropIds;
    summary.perParcel = perParcel;
  }

  return summary;
}

/** Exposed for the CLI's row-count clarity. */
export const __zoningStampInternal = { sql };
