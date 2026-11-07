/**
 * TxGIO/StratMap Address-Point GeoJSON feature -> normalized
 * `txgio_address` record.
 *
 * Field names follow the StratMap Address Points service schema
 * (feature.geographic.texas.gov Address_Points MapServer/0), verified
 * live 2026-07-15 against the Travis (48453) county slice:
 *
 *   objectid, full_addr, add_number, addnum_suf, unit, building, floor,
 *   st_premod, st_predir, st_pretyp, st_name, st_postyp, st_posdir,
 *   st_posmod, post_comm, post_code, state, country, county, fips,
 *   source, date_acq, dateupdate
 *
 * The store keeps the address label + parsed components + the point
 * lng/lat (from the GeoJSON Point geometry). It is county-partitioned
 * and joins to `txgio_parcel`/`cad_property` by situs, so we keep the
 * fields that back that join and the map display, not the full service
 * schema.
 */

import type { ParseCounters } from "../types";
import { recordSkip } from "../types";
import { cellKeyForPoint } from "../txgio/geo";

/** A normalized address point bound for `txgio_address`. */
export interface TxgioAddressRecord {
  countyFips: string;
  fullAddr: string;
  unit: string;
  /** Source OBJECTID — half of the table's primary key (migration 0110),
   *  never null here: a feature with no usable objectid is skipped by
   *  {@link normalizeAddressFeature} before this type is ever built. */
  objectId: number;
  addNumber: string | null;
  stName: string | null;
  postComm: string | null;
  postCode: string | null;
  state: string | null;
  countyName: string | null;
  source: string | null;
  dateAcq: string | null;
  longitude: number;
  latitude: number;
  tileKey: string;
}

/** GeoJSON Point feature as the address-point service emits it. */
export interface AddressFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/**
 * Point coordinate out of a GeoJSON Point geometry. Returns null for
 * any non-Point or non-finite pair — an address without a location can
 * neither be tiled nor point-joined to a parcel, so it is dropped.
 */
function pointOf(
  geometry: AddressFeature["geometry"],
): [number, number] | null {
  if (!geometry || geometry.type !== "Point") return null;
  const c = geometry.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;
  const lng = c[0];
  const lat = c[1];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/**
 * Normalize one address-point feature. Returns null (and counts a skip)
 * when the feature carries no usable point geometry, no `full_addr`, or
 * no usable `objectid` (the store's primary key, together with
 * county_fips, as of migration 0110 — a feature we cannot key is
 * declined, never inserted with a null/placeholder objectid).
 */
export function normalizeAddressFeature(
  countyFips: string,
  feature: AddressFeature,
  counters: ParseCounters,
): TxgioAddressRecord | null {
  const p = feature.properties ?? {};
  const fullAddr = str(p.full_addr);
  if (fullAddr === null) {
    recordSkip(counters, `objectid ${p.objectid ?? "?"}: no full_addr`);
    return null;
  }
  const objectId = intOrNull(p.objectid);
  if (objectId === null) {
    recordSkip(counters, `${fullAddr}: no usable objectid`);
    return null;
  }
  const point = pointOf(feature.geometry);
  if (point === null) {
    recordSkip(counters, `${fullAddr}: no point geometry`);
    return null;
  }
  const [longitude, latitude] = point;
  return {
    countyFips,
    fullAddr,
    // Unit is kept as a (non-key) column; normalize null -> "" so a
    // missing unit is a stable "" rather than null.
    unit: str(p.unit) ?? "",
    objectId,
    addNumber: str(p.add_number),
    stName: str(p.st_name),
    postComm: str(p.post_comm),
    postCode: str(p.post_code),
    state: str(p.state),
    countyName: str(p.county),
    source: str(p.source),
    dateAcq: str(p.date_acq),
    longitude,
    latitude,
    tileKey: cellKeyForPoint(longitude, latitude),
  };
}
