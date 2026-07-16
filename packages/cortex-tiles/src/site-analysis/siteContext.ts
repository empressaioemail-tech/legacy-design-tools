// packages/cortex-tiles/src/site-analysis/siteContext.ts
//
// BROKERAGE-shaped, ADDRESS-keyed site-context data function for the Property
// Brief MV3 extension (and any address/lat-lng consumer that has NO plan-review
// engagement). This is the peer of the engagement-keyed report functions in
// ./siteReports.ts, but for the brokerage data plane:
//
//   POST {baseUrl}/map-data
//     body: { latitude, longitude, address?, parcelKey?, jurisdictionCity?,
//             jurisdictionState?, layers?, forceRefresh? }
//
// The engagement-keyed model (siteReports.ts: run a report, then GET it, keyed
// by engagementId) is WRONG for the Brief — the Brief speaks
// /api/brokerage/v1/* keyed by address / lat-lng and gets its map layers
// BUNDLED in one response. `baseUrl` is supplied by the caller ending in the
// brokerage base (e.g. "https://host/api/brokerage/v1"); the /api/brokerage/v1
// prefix is NOT hardcoded here so an MV3 proxy or reverse-proxy can rewrite it.
//
// Pure, React-free, CSS-free. Callable from a vanilla MV3 page or the
// background service worker with no provider tree.
//
// ── Response shape (verified against the live handler) ──────────────
// The authoritative /map-data handler is
//   artifacts/api-server/src/routes/brokerageMapData.ts  (POST "/")
// and it responds with:
//   { mapData, reasoningOverlays, honesty, packageTier }
// where `mapData` is a MapLayersAssemblePayload
//   (artifacts/api-server/src/lib/engineSpineMapLayers.ts):
//   { parcelKey, place: { latitude, longitude, formattedAddress? },
//     tenantScope, layers: MapLayerSlot[], assembledAt }
// and each MapLayerSlot is:
//   { layerKey, status: 'ok'|'pending'|'no-coverage'|'failed', adapterKey?,
//     pendingReason?, envelope: { payload, confidence, dataVintage, coverage,
//     source } | null, error? }
// The `layerKey` values are the MapLayerKey enum shared with the request-body
// `layers` allowlist in brokerageMapData.ts:
//   'parcel-polygon' | 'flood-zone' | 'floodway' | 'dem' | 'topography' |
//   'opportunity-zone-tract' | 'zoning'
//
// NOTE on the two "site-context" shapes in this repo: `POST /brief`
// (fetchBrokerageSiteContext in artifacts/api-server/src/lib/brokerageSiteContext.ts)
// returns a DIFFERENT `siteContext { layers: BrokerageSiteContextLayer[] }`
// object on the brief body (layerKind-keyed, adapter-summarized). That is the
// brief's own layer set, not the /map-data assemble response. This function
// targets the /map-data assemble response as instructed; the extractors below
// key off the /map-data MapLayerSlot `layerKey` values. The field names here
// are copied verbatim from the two source types above — nothing is invented.
// If a future /map-data revision changes the slot/layerKey shape, re-verify
// against a live /map-data response and the two source types named above.

// ─── Injected-fetch seam ───────────────────────────────────────────
// An MV3 page cannot always hold the credential (the background service worker
// does). Every fetch here goes through an OPTIONAL injected fetch so the page
// can route the call through the worker (which attaches X-Hauska-Key /
// X-Hauska-Install-Id) instead of a direct page fetch. Defaults to global
// fetch. Shared by fetchSiteContext, fetchGisLayer, and the siteReports fns.
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface SiteContextFetchOpts {
  /** AbortSignal forwarded to the underlying fetch. */
  signal?: AbortSignal
  /**
   * Injected fetch. When provided it is used instead of global fetch — an MV3
   * page passes a fetch that proxies through the background service worker so
   * the worker (which holds the credential) performs the network call. When
   * omitted, global fetch is used.
   */
  fetch?: FetchLike
}

function resolveFetch(opts?: SiteContextFetchOpts): FetchLike {
  return opts?.fetch ?? ((input, init) => fetch(input, init))
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

// ─── Request / response types ──────────────────────────────────────

/** MapLayerKey — the /map-data assemble layer allowlist (verbatim). */
export type SiteContextLayerKey =
  | 'parcel-polygon'
  | 'flood-zone'
  | 'floodway'
  | 'dem'
  | 'topography'
  | 'opportunity-zone-tract'
  | 'zoning'

/** Address-keyed /map-data request body (verbatim from MAP_DATA_BODY). */
export interface SiteContextParams {
  latitude: number
  longitude: number
  address?: string | null
  parcelKey?: string
  jurisdictionCity?: string | null
  jurisdictionState?: string | null
  layers?: SiteContextLayerKey[]
  forceRefresh?: boolean
}

/**
 * One assembled map-layer slot (verbatim from MapLayerSlot). `envelope.payload`
 * carries the layer's GeoJSON / data blob; `status` is the honest per-layer
 * outcome (never a silent fixture).
 */
export interface SiteContextLayerSlot {
  layerKey: SiteContextLayerKey | string
  status: 'ok' | 'pending' | 'no-coverage' | 'failed'
  adapterKey?: string
  pendingReason?: string
  envelope: {
    payload: Record<string, unknown>
    confidence: { value: number; kind: string }
    dataVintage: string | null
    coverage: { degraded: boolean; reason?: string }
    source: { adapter: string; citationIds?: string[] }
  } | null
  error?: { code: string; message: string }
}

/** MapLayersAssemblePayload — the `mapData` object (verbatim). */
export interface SiteContextMapData {
  parcelKey: string
  place: {
    latitude: number
    longitude: number
    formattedAddress?: string | null
  }
  tenantScope: string
  layers: SiteContextLayerSlot[]
  assembledAt: string
}

/**
 * The full /map-data response envelope: `{ mapData, reasoningOverlays,
 * honesty, packageTier }`. This is what fetchSiteContext resolves to. The
 * extractors below read `mapData.layers`.
 */
export interface SiteContext {
  mapData: SiteContextMapData
  reasoningOverlays?: unknown[]
  honesty?: unknown
  packageTier?: string
}

/**
 * Error carrying the upstream HTTP status + parsed error code so an MV3 caller
 * can branch (e.g. 403 tier_required, 503 map_layers_unavailable).
 */
export class SiteContextHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public packageTier?: string | null,
  ) {
    super(message)
    this.name = 'SiteContextHttpError'
  }
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json()
    return body && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Address-keyed brokerage site-context fetch. POSTs the map-data body to
 * `${baseUrl}/map-data` and resolves the `{ mapData, reasoningOverlays,
 * honesty, packageTier }` envelope. Pure, React-free.
 *
 * `baseUrl` must already end in the brokerage base (e.g.
 * ".../api/brokerage/v1"); the /api/brokerage/v1 prefix is NOT hardcoded so an
 * MV3 proxy can route it. Auth (X-Hauska-Key / X-Hauska-Install-Id) is the
 * caller's responsibility — supply an injected `opts.fetch` that attaches it
 * (the MV3 worker-proxy pattern) or run same-origin with a session cookie.
 *
 * @throws SiteContextHttpError on any non-2xx (carrying status + error code).
 */
export async function fetchSiteContext(
  baseUrl: string,
  params: SiteContextParams,
  opts?: SiteContextFetchOpts,
): Promise<SiteContext> {
  const doFetch = resolveFetch(opts)
  const res = await doFetch(`${trimBase(baseUrl)}/map-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: opts?.signal,
  })

  if (!res.ok) {
    const body = await safeJson(res)
    const code = typeof body.error === 'string' ? body.error : undefined
    const message =
      (typeof body.message === 'string' && body.message) ||
      code ||
      `map-data failed (HTTP ${res.status})`
    const packageTier =
      typeof body.packageTier === 'string' ? body.packageTier : null
    throw new SiteContextHttpError(res.status, message, code, packageTier)
  }

  return (await res.json()) as SiteContext
}

// ─── Extractors (pure, sync, no fetch) ─────────────────────────────
// Thin readers over the resolved SiteContext. They pull a MapLayerSlot from
// `mapData.layers` by its `layerKey`. Return `null` when the layer is absent
// (never a fabricated slot). A caller checks `slot.status === 'ok'` and reads
// `slot.envelope?.payload` for the layer's GeoJSON / data.

function layerByKey(
  siteContext: SiteContext | null | undefined,
  ...keys: string[]
): SiteContextLayerSlot | null {
  const layers = siteContext?.mapData?.layers ?? []
  for (const key of keys) {
    const hit = layers.find((l) => l?.layerKey === key)
    if (hit) return hit
  }
  return null
}

/**
 * Hydrology / terrain-flow slot. The bundled /map-data assemble carries flow
 * as the DEM/topography slot (there is no separate 'hydrology' map layer — the
 * per-report hydrology model is the plan-review surface, not a /map-data
 * layer). Prefers the `dem` slot, falling back to `topography`.
 */
export function getHydrologyLayer(
  siteContext: SiteContext | null | undefined,
): SiteContextLayerSlot | null {
  return layerByKey(siteContext, 'dem', 'topography')
}

/**
 * Flood / hazard slot. FEMA flood in the brokerage GIS is the `flood-zone`
 * layer (see gis-proxy-api.js GIS_PROXY_LAYER_MAP: fema/floodplain ->
 * flood-zone); `floodway` is the secondary hazard slot.
 */
export function getHazardLayer(
  siteContext: SiteContext | null | undefined,
): SiteContextLayerSlot | null {
  return layerByKey(siteContext, 'flood-zone', 'floodway')
}

/** Topography (contour / terrain) slot. */
export function getTopographyLayer(
  siteContext: SiteContext | null | undefined,
): SiteContextLayerSlot | null {
  return layerByKey(siteContext, 'topography', 'dem')
}

/**
 * Parcel context slot (parcel polygon + joined attrs). Keyed 'parcel-polygon'
 * in the /map-data assemble (GIS_PROXY_LAYER_MAP: parcels -> parcel-polygon).
 */
export function getParcelContext(
  siteContext: SiteContext | null | undefined,
): SiteContextLayerSlot | null {
  return layerByKey(siteContext, 'parcel-polygon')
}

// ─── Setbacks: intentionally NOT a data function here ──────────────
// There is NO brokerage fetchSetbacks in this module. In the Brief, setbacks is
// a VERDICT / REASONING surface (brief-engine + the ICC gate), not a /map-data
// data fetch — it is composed from code atoms and the licensed I-Code gate,
// carrying its own reasoning + citations, not a raw layer pull. Leaving it out
// keeps the data-plane and reasoning-plane concerns separate. (The
// engagement-keyed fetchSetbacks in ./siteReports.ts is the plan-review
// setback-TABLE GET, a different surface.)
