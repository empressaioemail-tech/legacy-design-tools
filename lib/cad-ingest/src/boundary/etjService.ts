/**
 * ArcGIS REST client for per-publisher Texas ETJ layers
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * Mirrors `boundary/service.ts` (injectable `fetchJson`, bounded pagination
 * with `exceededTransferLimit`, polite inter-page delay, exit-bounded) and
 * adds the two things per-publisher ETJ needs that a single statewide layer
 * does not: an explicit membership predicate taken from the register, and a
 * coverage extent read in WGS84.
 *
 * EXTENTS ARE REQUESTED, NOT CONVERTED. These publishers return layer
 * metadata extents in their own projected SR — the register's services span
 * 102739, 102740, 102100, 102383 and 103160 — so `fetchEtjSourceMetadata`
 * reads the extent from `/query?returnExtentOnly=true&outSR=4326`, and the
 * coverage bbox stored in `tx_etj_source` is the publisher's own statement
 * about where its ETJ layer has data, issued in WGS84.
 *
 * The coverage extent is taken WITH the entry's membership predicate applied,
 * so it describes where that publisher's ETJ rings actually are. A query
 * point inside it is a point the publisher's ETJ layer covers, which is what
 * makes a miss mean `absent` rather than `unresolved`.
 *
 * Layer metadata verified live 2026-09-16 for every register entry; field
 * names and distinct membership values are recorded in `etjRegistry.ts`.
 */

import type { GeoBbox } from "../txgio/geo";
import { type EtjRegistryEntry, etjWhereClause } from "./etjRegistry";

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as Record<string, unknown>;
  const err = body.error as { code?: number; message?: string } | undefined;
  if (err) {
    throw new Error(`ArcGIS ${err.code ?? "?"}: ${err.message ?? "error"}`);
  }
  return body;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Server maxRecordCount observed across the register is 1000 or 2000. */
export const ETJ_MAX_PAGE_SIZE = 2000;
/** Polite delay between pages (~2 req/s), same as boundary-ingest. */
export const ETJ_RATE_MS = 500;

export interface EtjFetchOptions {
  limit?: number;
  fetchJson?: FetchJson;
  rateMs?: number;
  pageSize?: number;
  onPage?: (info: { offset: number; got: number; total: number }) => void;
}

/** One raw GeoJSON feature as the publisher returned it. */
export interface EtjRawFeature {
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

export interface EtjSourceMetadata {
  layerName: string | null;
  displayField: string | null;
  objectIdField: string | null;
  /** Extent of this entry's ETJ selection, in WGS84. */
  extentWgs84: GeoBbox | null;
  /** Publisher's own last-edit timestamp, ISO, when published. */
  lastEditAt: string | null;
  maxRecordCount: number;
  /** Field names the layer actually carries. */
  fieldNames: string[];
}

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read the publisher's layer metadata for one register entry. */
export async function fetchEtjSourceMetadata(
  entry: EtjRegistryEntry,
  opts: Pick<EtjFetchOptions, "fetchJson"> = {},
): Promise<EtjSourceMetadata> {
  if (entry.layerUrl === null) {
    throw new Error(`etj: ${entry.cityKey} has no layer URL (mode ${entry.mode})`);
  }
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const layer = entry.layerUrl.replace(/\/$/, "");
  const where = etjWhereClause(entry);

  const meta = (await fetchJson(`${layer}?f=json`)) as Record<string, unknown>;
  const rawFields = Array.isArray(meta.fields) ? meta.fields : [];
  const fieldNames: string[] = [];
  for (const f of rawFields) {
    const name = str((f as Record<string, unknown>)?.name);
    if (name) fieldNames.push(name);
  }

  const extentRes = (await fetchJson(
    `${layer}/query?where=${encodeURIComponent(where)}` +
      `&returnExtentOnly=true&outSR=4326&f=json`,
  )) as { extent?: Record<string, unknown> };
  const e = extentRes.extent;
  const westLng = num(e?.xmin);
  const southLat = num(e?.ymin);
  const eastLng = num(e?.xmax);
  const northLat = num(e?.ymax);
  const extentWgs84: GeoBbox | null =
    westLng !== null && southLat !== null && eastLng !== null && northLat !== null
      ? { westLng, southLat, eastLng, northLat }
      : null;

  const editing = meta.editingInfo as { lastEditDate?: unknown } | undefined;
  const lastEditMs = num(editing?.lastEditDate);
  const editingLastEdit = num(meta.lastEditDate);

  const oidField = str(meta.objectIdField);

  return {
    layerName: str(meta.name),
    displayField: str(meta.displayField),
    objectIdField: oidField,
    extentWgs84,
    lastEditAt:
      lastEditMs !== null
        ? new Date(lastEditMs).toISOString()
        : editingLastEdit !== null
          ? new Date(editingLastEdit).toISOString()
          : null,
    maxRecordCount: num(meta.maxRecordCount) ?? 1000,
    fieldNames,
  };
}

/** Single bounded call: how many ETJ rings this entry's predicate selects. */
export async function countEtjFeatures(
  entry: EtjRegistryEntry,
  opts: Pick<EtjFetchOptions, "fetchJson"> = {},
): Promise<number> {
  if (entry.layerUrl === null) return 0;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const body = (await fetchJson(
    `${entry.layerUrl.replace(/\/$/, "")}/query?where=${encodeURIComponent(
      etjWhereClause(entry),
    )}&returnCountOnly=true&f=json`,
  )) as { count?: number };
  return typeof body.count === "number" ? body.count : 0;
}

/**
 * Async-generate every ETJ feature this entry's predicate selects, in WGS84.
 * Exit-bounded: pages until the publisher reports no further records.
 */
export async function* fetchEtjBoundaryFeatures(
  entry: EtjRegistryEntry,
  opts: EtjFetchOptions = {},
): AsyncGenerator<EtjRawFeature> {
  if (entry.layerUrl === null) return;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const rateMs = opts.rateMs ?? ETJ_RATE_MS;
  const pageSize = Math.min(
    opts.pageSize ?? ETJ_MAX_PAGE_SIZE,
    ETJ_MAX_PAGE_SIZE,
  );
  const layer = entry.layerUrl.replace(/\/$/, "");
  const where = etjWhereClause(entry);
  let offset = 0;
  let total = 0;
  for (;;) {
    const remaining = opts.limit !== undefined ? opts.limit - total : pageSize;
    if (remaining <= 0) return;
    const want = Math.min(pageSize, remaining);
    const url =
      `${layer}/query?where=${encodeURIComponent(where)}` +
      `&outFields=*&resultOffset=${offset}&resultRecordCount=${want}` +
      `&returnGeometry=true&outSR=4326&f=geojson`;
    const page = (await fetchJson(url)) as {
      features?: unknown[];
      exceededTransferLimit?: boolean;
    };
    const feats = Array.isArray(page.features) ? page.features : [];
    for (const f of feats) {
      yield f as EtjRawFeature;
      total += 1;
      if (opts.limit !== undefined && total >= opts.limit) {
        opts.onPage?.({ offset, got: feats.length, total });
        return;
      }
    }
    opts.onPage?.({ offset, got: feats.length, total });
    if (feats.length < want || page.exceededTransferLimit !== true) return;
    offset += feats.length;
    await sleep(rateMs);
  }
}

/** Names of register cities that publish a queryable ETJ layer. */
export function etjLayerCitation(entry: EtjRegistryEntry): string {
  return entry.layerUrl ?? `${entry.cityKey}: no published ETJ layer`;
}

export { str as etjString, num as etjNumber };
