/**
 * ArcGIS REST clients for statewide Texas city and county boundary layers.
 *
 * Four-point probe evidence (2026-08-08, primary probe):
 *
 * CITY — TxGIO City_Boundaries/Texas_City_Boundaries/MapServer
 *   1. Service root layer list: one layer id=0, name="Tx City Boundaries",
 *      geometryType=esriGeometryPolygon.
 *   2. Id field: `geo_id` (alias GEO_ID, esriFieldTypeString, length 7);
 *      displayField=CITY_NAME; companion fields city_name, gnis.
 *   3. Sample polygon: city_name='Austin', geo_id='4805000', Polygon rings.
 *   4. Feature count: 1225. Owner: TxGIO/CPA (copyrightText cites Texas
 *      Comptroller of Public Accounts + U.S. Census Bureau).
 *
 * Adversarial re-probe (2026-08-08, independent confirmation):
 *   - returnIdsOnly on layer 0 returns objectIds (confirms queryable layer 0).
 *   - geo_id='4805000' sample returns Austin Polygon (not a point/line layer).
 *   - Service root lists exactly one feature layer (no layer-index ambiguity).
 *
 * COUNTY — Census TIGERweb State_County/MapServer (TxGIO has NO county layer;
 * every TxGIO folder probed 2026-08-08 — no County_Boundaries service exists)
 *   1. Service root layer list: layer id=0 "States", id=1 "Counties" (both
 *      esriGeometryPolygon; Counties is id=1, NOT id=0).
 *   2. Id field: `GEOID` (5-digit county FIPS); companion NAME, STATE, COUNTY.
 *   3. Sample polygon: GEOID='48453', NAME='Travis County', Polygon.
 *   4. Feature count: 254 where STATE='48'. Owner: U.S. Census Bureau.
 *
 * Adversarial re-probe (2026-08-08):
 *   - Layer 0 WHERE STATE='48' returnCountOnly=1 (Texas state polygon).
 *   - Layer 1 WHERE STATE='48' returnCountOnly=254 (counties, not states).
 *   - Confirms layer index 1 is Counties; layer 0 would be wrong (Caldwell trap).
 */

const TXGIO_HOST =
  "https://feature.geographic.texas.gov/arcgis/rest/services";
const TIGER_HOST =
  "https://tigerweb.geo.census.gov/arcgis/rest/services";

export const CITY_LAYER_PATH =
  "City_Boundaries/Texas_City_Boundaries/MapServer/0";
export const COUNTY_LAYER_PATH = "TIGERweb/State_County/MapServer/1";

export const CITY_SOURCE_CITATION = `${TXGIO_HOST}/${CITY_LAYER_PATH}`;
export const COUNTY_SOURCE_CITATION = `${TIGER_HOST}/${COUNTY_LAYER_PATH}`;

export const CITY_DEFAULT_VINTAGE = "txgio_city_boundaries_202508";
export const COUNTY_DEFAULT_VINTAGE = "tiger_state_county_acs2024";

/** Server maxRecordCount for the city layer (verified live). */
export const BOUNDARY_PAGE_SIZE = 2000;
/** Polite delay between pages (~2 req/s). */
export const BOUNDARY_RATE_MS = 500;

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

export function cityLayerUrl(host: string = TXGIO_HOST): string {
  return `${host}/${CITY_LAYER_PATH}`;
}

export function countyLayerUrl(host: string = TIGER_HOST): string {
  return `${host}/${COUNTY_LAYER_PATH}`;
}

export interface BoundaryFetchOptions {
  limit?: number;
  host?: string;
  fetchJson?: FetchJson;
  rateMs?: number;
  onPage?: (info: { offset: number; got: number; total: number }) => void;
}

/** Single bounded call: statewide city feature count. */
export async function countCityBoundaries(
  opts: Pick<BoundaryFetchOptions, "host" | "fetchJson"> = {},
): Promise<number> {
  const layer = cityLayerUrl(opts.host);
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const url = `${layer}/query?where=1%3D1&returnCountOnly=true&f=json`;
  const body = (await fetchJson(url)) as { count?: number };
  return typeof body.count === "number" ? body.count : 0;
}

/** Single bounded call: Texas county feature count. */
export async function countCountyBoundaries(
  opts: Pick<BoundaryFetchOptions, "host" | "fetchJson"> = {},
): Promise<number> {
  const layer = countyLayerUrl(opts.host);
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const url =
    `${layer}/query?where=${encodeURIComponent("STATE='48'")}` +
    `&returnCountOnly=true&f=json`;
  const body = (await fetchJson(url)) as { count?: number };
  return typeof body.count === "number" ? body.count : 0;
}

async function* fetchLayerFeatures(
  layerUrl: string,
  where: string,
  opts: BoundaryFetchOptions,
): AsyncGenerator<unknown> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const rateMs = opts.rateMs ?? BOUNDARY_RATE_MS;
  let offset = 0;
  let total = 0;
  for (;;) {
    const remaining =
      opts.limit !== undefined ? opts.limit - total : BOUNDARY_PAGE_SIZE;
    if (remaining <= 0) return;
    const want = Math.min(BOUNDARY_PAGE_SIZE, remaining);
    const url =
      `${layerUrl}/query?where=${encodeURIComponent(where)}` +
      `&outFields=*&resultOffset=${offset}&resultRecordCount=${want}` +
      `&returnGeometry=true&outSR=4326&f=geojson`;
    const page = (await fetchJson(url)) as {
      features?: unknown[];
      exceededTransferLimit?: boolean;
    };
    const feats = Array.isArray(page.features) ? page.features : [];
    for (const f of feats) {
      yield f;
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

/** Async-generate all city boundary features. Exit-bounded by pagination. */
export async function* fetchCityBoundaryFeatures(
  opts: BoundaryFetchOptions = {},
): AsyncGenerator<unknown> {
  yield* fetchLayerFeatures(cityLayerUrl(opts.host), "1=1", opts);
}

/** Async-generate all Texas county boundary features. Exit-bounded. */
export async function* fetchCountyBoundaryFeatures(
  opts: BoundaryFetchOptions = {},
): AsyncGenerator<unknown> {
  yield* fetchLayerFeatures(countyLayerUrl(opts.host), "STATE='48'", opts);
}
