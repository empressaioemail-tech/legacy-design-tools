/**
 * Parcel history from the TxGIO Land Parcels annual releases, in the P-499
 * shape: each release is its own `source_feature` provider
 * (`txgio.parcels.<year>`, lib/source-registry) and partition (migration
 * 0117), written through the stage-check-swap path (`source_feature_stage`,
 * then `swapStagedCounty`). No per-state table.
 *
 * A release is one county-year snapshot of the appraisal district's
 * parcels: polygon, owner, situs, legal description, CAD values, the roll's
 * own TAX_YEAR and year built. Geometry goes through the SAME
 * `normalizeTxgioFeature` gate the current store uses, so a history row is
 * never looser than a current row.
 *
 * Values are kept as published. A blank becomes null. A year of 0 (the
 * releases' "not stated") becomes null, since no building was built in year
 * 0. A published 0 value is kept: it is what the roll said.
 *
 * Key (registry rule `county-release-propid-geometry-sha256`):
 * sha256(county | vintage | prop_id | geometry with sorted keys). Content-
 * derived and stable across a re-fetch of the same release; never the
 * shapefile position. Exact duplicate features collapse to one key and are
 * counted, never silently.
 */
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sourceFeature, sourceFeatureStage } from "@workspace/db/schema";

import type { ParseCounters } from "../types";
import { normalizeTxgioFeature, type TxgioFeature, type TxgioNormalizeOptions } from "./parse";

/** Registry provider for one release (lib/source-registry `parcelReleaseProvider`). */
export function parcelReleaseProvider(year: number): string {
  return `txgio.parcels.${year}`;
}

/**
 * Program year from a release label. Two forms are published: "stratmap22-landparcels_48021_..."
 * (2019-2025) and "stratmap-2026-land-parcels-bastrop_48021" (2026, read from the real file
 * 2026-11-05).
 */
export function releaseYearFromLabel(label: string): number | null {
  const m = /stratmap-?(\d{4}|\d{2})(?!\d)/i.exec(label);
  if (!m) return null;
  const y = m[1]!.length === 4 ? Number(m[1]) : 2000 + Number(m[1]);
  return y >= 2000 && y <= 2100 ? y : null;
}

function text(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  // NUL reads as a space, as in parse.ts `str`: Postgres jsonb refuses it (SQLSTATE 22P05).
  const t = v.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/** A failed database call's own error, SQLSTATE first. drizzle wraps the pg error as `cause` and prints only the query. */
export function describeDbError(e: unknown): string {
  const err = e as { code?: string; message?: string; detail?: string; cause?: { code?: string; message?: string; detail?: string } };
  const inner = err?.cause ?? err;
  const code = inner?.code ?? err?.code ?? "unknown";
  const detail = inner?.detail ? ` (${inner.detail})` : "";
  return `SQLSTATE ${code}: ${inner?.message ?? err?.message ?? String(e)}${detail}`;
}

/** A published money value as a number, or null when blank or not a number. */
export function publishedValue(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A published year, or null when blank, 0 ("not stated") or outside [min, max]. */
export function publishedYear(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The registry's declared key for one release feature. */
export function releaseKey(countyFips: string, vintage: string, propId: string | null, geometry: unknown): string {
  return createHash("sha256").update(`${countyFips}|${vintage}|${propId ?? ""}|${sortedJson(geometry)}`).digest("hex");
}

export interface ReleaseContext {
  year: number;
  vintage: string;
  sourceUrl: string;
  loadRunId: string;
  fetchedAt: Date;
  normalize?: TxgioNormalizeOptions;
}

export interface ReleaseStageRow {
  provider: string;
  providerObjectId: string;
  stateFips: string;
  countyFips: string;
  vintage: string;
  fetchedAt: Date;
  loadRunId: string;
  sourceUrl: string;
  geometry: unknown;
  payload: Record<string, unknown>;
}

/** One stage row from one release feature, or null when its geometry is refused. */
export function releaseRowFromFeature(
  countyFips: string,
  featureIndex: number,
  feature: TxgioFeature,
  counters: ParseCounters,
  ctx: ReleaseContext,
): ReleaseStageRow | null {
  const rec = normalizeTxgioFeature(countyFips, featureIndex, feature, counters, ctx.normalize ?? {});
  if (!rec) return null;
  const p = feature.properties ?? {};
  return {
    provider: parcelReleaseProvider(ctx.year),
    providerObjectId: releaseKey(countyFips, ctx.vintage, rec.propId, rec.geometry),
    stateFips: countyFips.slice(0, 2),
    countyFips,
    vintage: ctx.vintage,
    fetchedAt: ctx.fetchedAt,
    loadRunId: ctx.loadRunId,
    sourceUrl: ctx.sourceUrl,
    geometry: rec.geometry,
    payload: {
      release_year: ctx.year,
      prop_id: rec.propId,
      geo_id: rec.geoId,
      owner_name: rec.ownerName,
      situs_address: rec.situsAddress,
      situs_city: rec.situsCity,
      situs_state: rec.situsState,
      situs_zip: rec.situsZip,
      legal_desc: text(p.LEGAL_DESC),
      land_value: publishedValue(p.LAND_VALUE),
      imp_value: publishedValue(p.IMP_VALUE),
      mkt_value: publishedValue(p.MKT_VALUE),
      tax_year: publishedYear(p.TAX_YEAR, 1900, 2100),
      year_built: publishedYear(p.YEAR_BUILT, 1700, 2100),
    },
  };
}

/** Distinct keys among rows: the swap's expected count. */
export function countReleaseKeys(rows: Iterable<{ providerObjectId: string }>): number {
  const s = new Set<string>();
  for (const r of rows) s.add(r.providerObjectId);
  return s.size;
}

export type ReleaseStageDb = Pick<NodePgDatabase<Record<string, unknown>>, "insert">;

/** Stage one batch. A duplicate key within the run collapses (ON CONFLICT DO NOTHING). Returns rows staged. */
export async function stageReleaseRows(db: ReleaseStageDb, rows: ReleaseStageRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(({ geometry, ...r }) => ({
    ...r,
    geom: sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)` as unknown as string,
  }));
  const res = (await db.insert(sourceFeatureStage).values(values).onConflictDoNothing()) as unknown as { rowCount?: number };
  return res?.rowCount ?? 0;
}

/**
 * The parcel as published in the latest release AT OR BEFORE `year`. One
 * row per feature of that release (a split parcel can have several). Empty
 * means no loaded release that early carries the account, not that it did
 * not exist.
 */
export function parcelAsOfSql(countyFips: string, propId: string, year: number): SQL {
  const release = sql`split_part(${sourceFeature.provider}, '.', 3)::int`;
  return sql`
    SELECT ${sourceFeature.provider} AS provider, ${sourceFeature.vintage} AS vintage,
           ${sourceFeature.payload} AS payload, ST_AsGeoJSON(${sourceFeature.geom}) AS geometry
      FROM ${sourceFeature}
     WHERE ${sourceFeature.provider} ~ '^txgio[.]parcels[.][0-9]{4}$'
       AND ${sourceFeature.countyFips} = ${countyFips}
       AND ${sourceFeature.payload} ->> 'prop_id' = ${propId}
       AND ${release} = (
         SELECT max(split_part(provider, '.', 3)::int) FROM ${sourceFeature}
          WHERE provider ~ '^txgio[.]parcels[.][0-9]{4}$'
            AND county_fips = ${countyFips}
            AND payload ->> 'prop_id' = ${propId}
            AND split_part(provider, '.', 3)::int <= ${year}
       )`;
}
