/**
 * Parcel history from the TxGIO Land Parcels annual releases.
 *
 * Each StratMap release (stratmap19, 21-26) is one county-year snapshot of
 * the appraisal district's parcels: polygon, owner, situs, legal
 * description, CAD values, the roll's tax year and year built. This module
 * turns a release's shapefile features into `txgio_parcel_vintage` rows and
 * answers "what was this parcel in year Y" from them.
 *
 * Geometry goes through the SAME `normalizeTxgioFeature` gate the current
 * store uses (polygon validity, Texas envelope, reprojection on request), so
 * a history row is never looser than a current row.
 *
 * Values are taken as published. A blank becomes NULL. A year of 0 (the
 * releases' "not stated") becomes NULL, since no building was built in year
 * 0. A value of 0 is kept: it is what the roll published.
 */
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioParcelVintage, type TxgioParcelVintageInsert } from "@workspace/db/schema";

import type { ParseCounters } from "../types";
import { normalizeTxgioFeature, type TxgioFeature, type TxgioNormalizeOptions } from "./parse";

/** Program year from a release label: "stratmap22-landparcels_48021_..." -> 2022. */
export function vintageYearFromLabel(label: string): number | null {
  const m = /stratmap(\d{2})(?!\d)/i.exec(label);
  return m ? 2000 + Number(m[1]) : null;
}

function text(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/** A published money value as a numeric string, or null when blank or not a number. */
export function publishedValue(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? String(n) : null;
}

/** A published year, or null when blank, 0 ("not stated") or outside [min, max]. */
export function publishedYear(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export interface VintageContext {
  sourceVintage: string;
  vintageYear: number;
  sourceFile: string;
  normalize?: TxgioNormalizeOptions;
}

/** One history row from one release feature, or null when its geometry is refused. */
export function historyRowFromFeature(
  countyFips: string,
  featureIndex: number,
  feature: TxgioFeature,
  counters: ParseCounters,
  ctx: VintageContext,
): TxgioParcelVintageInsert | null {
  const rec = normalizeTxgioFeature(countyFips, featureIndex, feature, counters, ctx.normalize ?? {});
  if (!rec) return null;
  const p = feature.properties ?? {};
  return {
    countyFips,
    sourceVintage: ctx.sourceVintage,
    vintageYear: ctx.vintageYear,
    featureIndex,
    propId: rec.propId,
    geoId: rec.geoId,
    ownerName: rec.ownerName,
    situsAddress: rec.situsAddress,
    situsCity: rec.situsCity,
    situsState: rec.situsState,
    situsZip: rec.situsZip,
    legalDesc: text(p.LEGAL_DESC),
    landValue: publishedValue(p.LAND_VALUE),
    impValue: publishedValue(p.IMP_VALUE),
    mktValue: publishedValue(p.MKT_VALUE),
    taxYear: publishedYear(p.TAX_YEAR, 1900, 2100),
    yearBuilt: publishedYear(p.YEAR_BUILT, 1700, 2100),
    geometry: rec.geometry,
    westLng: rec.bbox.westLng,
    southLat: rec.bbox.southLat,
    eastLng: rec.bbox.eastLng,
    northLat: rec.bbox.northLat,
    sourceFile: ctx.sourceFile,
  };
}

export type VintageHistoryDb = Pick<NodePgDatabase<Record<string, unknown>>, "insert">;

/**
 * Insert one batch. Append-only: a row already present for
 * (county, vintage, feature) is left exactly as it is (ON CONFLICT DO
 * NOTHING), so a vintage, once loaded, is what was published. Returns rows
 * inserted.
 */
export async function insertVintageRows(db: VintageHistoryDb, rows: TxgioParcelVintageInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const withGeom = rows.map((r) => ({
    ...r,
    geom: sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(r.geometry)}), 4326)` as unknown as string,
  }));
  const res = (await db.insert(txgioParcelVintage).values(withGeom).onConflictDoNothing()) as unknown as {
    rowCount?: number;
  };
  return res?.rowCount ?? 0;
}

/**
 * The parcel as published in the latest release AT OR BEFORE `year`: what
 * the record said about it in that year. One row per feature of that
 * release (a split parcel can have several). An empty result means no
 * loaded release that early carries the account, not that it did not exist.
 */
export function parcelAsOfSql(countyFips: string, propId: string, year: number): SQL {
  return sql`
    SELECT * FROM ${txgioParcelVintage}
     WHERE county_fips = ${countyFips}
       AND prop_id = ${propId}
       AND vintage_year = (
         SELECT max(vintage_year) FROM ${txgioParcelVintage}
          WHERE county_fips = ${countyFips} AND prop_id = ${propId} AND vintage_year <= ${year}
       )
     ORDER BY feature_index`;
}
