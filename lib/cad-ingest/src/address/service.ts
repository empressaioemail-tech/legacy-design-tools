/**
 * TxGIO/StratMap Address-Point ArcGIS REST client.
 *
 * The StratMap Address Points layer is OPEN paginated ArcGIS REST
 * (verified live 2026-07-15): no auth, `f=geojson`, `resultOffset`
 * pagination with a server `maxRecordCount` of 2000, a `county='<name>'`
 * WHERE filter, and `returnCountOnly` for a bounded pre-count. The
 * parcels `_most_recent` service is display-only (its /query 400s), but
 * the address-point service answers /query, so no bulk download is
 * needed here.
 *
 * The crawl is EXIT-BOUNDED and county-partitioned: `countAddressPoints`
 * is a single call, and `fetchAddressFeatures` async-generates one
 * county's features page by page and RETURNS when the server stops
 * paging (or an optional `limit` is hit). A statewide pull is the caller
 * looping over counties, each resumable independently — never a single
 * unbounded stream.
 */

const DEFAULT_HOST =
  "https://feature.geographic.texas.gov/arcgis/rest/services";
const ADDRESS_LAYER_PATH =
  "Address_Points/stratmap_address_points_48_most_recent/MapServer/0";

/** Server `maxRecordCount` for this layer (verified live). */
export const ADDRESS_PAGE_SIZE = 2000;
/** Polite delay between pages (~2 req/s). */
export const ADDRESS_RATE_MS = 500;

export function addressLayerUrl(host: string = DEFAULT_HOST): string {
  return `${host}/${ADDRESS_LAYER_PATH}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal fetch shape so tests can inject a fake without a network
 * call. Matches the global `fetch` signature for the calls we make.
 */
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

/**
 * Escape a county name for an ArcGIS SQL `county='...'` WHERE. Single
 * quotes are doubled (SQL string escaping); the values are TxGIO county
 * names, but escape anyway rather than trust the input.
 */
function whereCounty(countyName: string): string {
  return encodeURIComponent(`county='${countyName.replace(/'/g, "''")}'`);
}

export interface AddressServiceOptions {
  /** County display name as the service knows it, e.g. `Travis`. */
  countyName: string;
  /** Cap the number of features generated (bounded sample runs). */
  limit?: number;
  /** Override the layer host (tests / mirrors). */
  host?: string;
  /** Injected fetch-json (tests). Defaults to global fetch. */
  fetchJson?: FetchJson;
  /** Delay between pages in ms. Defaults to ADDRESS_RATE_MS. */
  rateMs?: number;
  /** Per-page progress callback. */
  onPage?: (info: { offset: number; got: number; total: number }) => void;
}

/** Single bounded call: statewide/county feature count. */
export async function countAddressPoints(
  opts: Pick<AddressServiceOptions, "countyName" | "host" | "fetchJson">,
): Promise<number> {
  const layer = addressLayerUrl(opts.host);
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const url =
    `${layer}/query?where=${whereCounty(opts.countyName)}` +
    `&returnCountOnly=true&f=json`;
  const body = (await fetchJson(url)) as { count?: number };
  return typeof body.count === "number" ? body.count : 0;
}

/**
 * Async-generate one county's address-point features. Pages by
 * `resultOffset` at `ADDRESS_PAGE_SIZE`, sleeps `rateMs` between pages,
 * and RETURNS when the server stops paging or `limit` features have been
 * yielded. Exit-bounded by construction.
 */
export async function* fetchAddressFeatures(
  opts: AddressServiceOptions,
): AsyncGenerator<unknown> {
  const layer = addressLayerUrl(opts.host);
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const rateMs = opts.rateMs ?? ADDRESS_RATE_MS;
  const where = whereCounty(opts.countyName);

  let offset = 0;
  let total = 0;
  for (;;) {
    const remaining =
      opts.limit !== undefined ? opts.limit - total : ADDRESS_PAGE_SIZE;
    if (remaining <= 0) return;
    const want = Math.min(ADDRESS_PAGE_SIZE, remaining);
    const url =
      `${layer}/query?where=${where}` +
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
    // Stop when the server returned a short page or signalled no more.
    if (feats.length < want || page.exceededTransferLimit !== true) return;
    offset += feats.length;
    await sleep(rateMs);
  }
}
