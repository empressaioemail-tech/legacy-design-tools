// packages/cortex-tiles/src/map/liveGis.ts
//
// Pure logic for the live-GIS Map tile: viewport -> fetch policy, the
// map-data/gis-layer client, response -> OverlaySpec conversion, and the
// parcel-selection -> info-card mapping. Kept free of React/MapLibre so the
// loader, labeling, and error rules are unit-testable.
//
// PROMOTED from apps/command-center (hauska-map) into the published library so
// every consumer (command center, Property Brief, the Brief extension, future
// apps) gets the SAME live map instead of the fixture-only MapTile. The live
// map was the original library tile and the reason the library exists.
//
// Data plane: POST {cortex proxy}/brokerage/v1/map-data/gis-layer with
// { layer, bbox } (the exact-match POST allowlist). Response envelope:
//   { layer, provider, adapterKey, serviceUrl, featureCount, queryMode,
//     truncated, geojson: FeatureCollection, packageTier,
//     notSurveyGrade?, disclaimer? }
// Parcel feature properties: apn, situsAddress, owner, landUseCode?,
// landUseDescription?, countyFips, countyName, provider, retrievedAt,
// notSurveyGrade. FEMA feature properties: FLD_ZONE, SFHA_TF, ...

import type { OverlaySpec, ParcelSelection } from '@hauska/map-renderer'

// The viewport wire shapes the loader owns. Defined locally (structurally
// identical to @hauska/map-renderer's GisBBox / ViewportState) so the library
// does not depend on renderer exports that the currently PUBLISHED
// @hauska/map-renderer (0.1.1) has not shipped yet — the renderer's
// onViewportChange / ViewportState / GisBBox seam is on hauska-map main but not
// in the published dist. Structural typing makes these interchangeable with the
// renderer's own types once it publishes, with no consumer change.
export interface GisBBox {
  west: number
  south: number
  east: number
  north: number
}

export interface ViewportState {
  bbox: GisBBox
  zoom: number
}

/**
 * OverlaySpec extended with the `interactive` flag the live parcels layer needs
 * (published OverlaySpec 0.1.1 lacks the field; passing it is harmless — the
 * renderer ignores unknown keys until it consumes it). Kept assignable to
 * OverlaySpec[] so it threads straight into FloatingMap's `overlays` prop.
 */
export type LiveOverlaySpec = OverlaySpec & { interactive?: boolean }

export type LiveLayerKey = 'parcels' | 'fema'

/** Overlay layerKeys the live loader owns on the map. */
export const LIVE_PARCELS_KEY = 'live-parcels'
export const LIVE_FEMA_KEY = 'live-fema'

/** Parcels are bbox-capped (~200 features upstream); below this zoom we show
 *  a "zoom in" hint instead of hammering the API with huge viewports. */
export const MIN_PARCEL_ZOOM = 14
/** FEMA flood polygons are coarser; fetchable a bit wider out. */
export const MIN_FEMA_ZOOM = 11

export interface GeoJsonFeature {
  type: 'Feature'
  geometry: unknown
  properties: Record<string, unknown> | null
}

export interface FeatureCollectionLike {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

export interface GisLayerResponse {
  layer: string
  provider?: string
  adapterKey?: string
  featureCount?: number
  truncated?: boolean
  notSurveyGrade?: boolean
  disclaimer?: string
  geojson?: FeatureCollectionLike
}

export type LiveLayerState =
  | { status: 'idle' }
  | { status: 'zoom-gated' }
  | { status: 'loading' }
  | { status: 'ok'; response: GisLayerResponse }
  | { status: 'no-coverage'; detail?: string }
  | { status: 'error'; message: string }
  /**
   * The per-layer failure latch tripped: this layer returned a client/server
   * error (400/403/5xx) or a network error, so the loop has STOPPED re-issuing
   * its bbox query for the session. Renders as an honest empty overlay (no
   * throw, no retry loop). This is the storm guard — the reason a broken
   * endpoint can never exhaust the browser connection pool.
   */
  | { status: 'suppressed'; message: string }

/** Which live layers to fetch at this zoom. */
export function layersForZoom(zoom: number): LiveLayerKey[] {
  const layers: LiveLayerKey[] = []
  if (zoom >= MIN_FEMA_ZOOM) layers.push('fema')
  if (zoom >= MIN_PARCEL_ZOOM) layers.push('parcels')
  return layers
}

/**
 * Injected fetch. When provided, fetchGisLayer routes the network call through
 * it instead of global fetch — the MV3 worker-proxy seam (the background
 * service worker holds the credential). Defaults to global fetch.
 */
export type GisFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface GisLayerOpts {
  /** AbortSignal forwarded to the underlying fetch. */
  signal?: AbortSignal
  /** Injected fetch (MV3 worker-proxy); defaults to global fetch. */
  fetch?: GisFetchLike
}

/**
 * Pick EXACTLY {west,south,east,north} off whatever the renderer's viewport
 * emit hands us. The server's GIS_BBOX_BODY is `.strict()` — it rejects on ANY
 * extra key (e.g. a `zoom` carried alongside the bounds, which is the shape the
 * pre-library home-grown client sent and the shape that produced the observed
 * "Unrecognized key" 400s). Sending a strict-clean bbox is what makes the body
 * pass the exact-match POST allowlist regardless of what the viewport object
 * carries. Non-finite coordinates are dropped to `null` so a malformed viewport
 * degrades to an honest error rather than a rejected request.
 */
export function normalizeBbox(bbox: GisBBox): GisBBox {
  const n = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : NaN
  return {
    west: n(bbox?.west),
    south: n(bbox?.south),
    east: n(bbox?.east),
    north: n(bbox?.north),
  }
}

/**
 * POST one bbox gis-layer query through the cortex proxy.
 * Maps HTTP outcomes onto honest tile states:
 *   200 -> ok, 404 -> no-coverage, anything else -> named error (NEVER a silent
 *   fixture fallback).
 *
 * NOTE: `baseUrl` is caller-supplied and works for a brokerage base — the path
 * appended here is `/brokerage/v1/map-data/gis-layer`, so pass the origin/proxy
 * root (e.g. ".../api"), NOT a base already ending in "/brokerage/v1". A
 * vanilla MV3 consumer can drive this headless (see the "./site-analysis"
 * subpath export); pass `opts.fetch` to route through the worker.
 *
 * Back-compat: the 4th arg accepts either a bare AbortSignal (legacy) or a
 * GisLayerOpts object `{ signal?, fetch? }`.
 */
export async function fetchGisLayer(
  baseUrl: string,
  layer: LiveLayerKey,
  bbox: GisBBox,
  signalOrOpts?: AbortSignal | GisLayerOpts,
): Promise<LiveLayerState> {
  const opts: GisLayerOpts =
    signalOrOpts && 'aborted' in (signalOrOpts as AbortSignal)
      ? { signal: signalOrOpts as AbortSignal }
      : ((signalOrOpts as GisLayerOpts) ?? {})
  const signal = opts.signal
  const doFetch: GisFetchLike = opts.fetch ?? ((input, init) => fetch(input, init))
  // STRICT-CLEAN body: exactly { layer, bbox: {west,south,east,north} }. The
  // server body is `.strict()`; any stray key (a `zoom` alongside the bounds,
  // renderer internals) is a 400. Pin the shape here so no viewport carrier can
  // trip the exact-match allowlist.
  const cleanBbox = normalizeBbox(bbox)
  let res: Response
  try {
    res = await doFetch(`${baseUrl.replace(/\/$/, '')}/brokerage/v1/map-data/gis-layer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer, bbox: cleanBbox }),
      signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    return { status: 'error', message: `${layer}: ${(err as Error)?.message || 'network error'}` }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body -- handled by status below */
  }
  const rec = (body ?? {}) as Record<string, unknown>

  if (res.status === 404) {
    return {
      status: 'no-coverage',
      detail: typeof rec.message === 'string' ? rec.message : undefined,
    }
  }
  if (!res.ok) {
    const detail =
      (typeof rec.message === 'string' && rec.message) ||
      (typeof rec.error === 'string' && rec.error) ||
      `HTTP ${res.status}`
    return { status: 'error', message: `${layer}: ${detail}` }
  }
  return { status: 'ok', response: rec as unknown as GisLayerResponse }
}

// ---------------------------------------------------------------------------
// Storm guard: per-layer failure latch
// ---------------------------------------------------------------------------
//
// THE PRIMARY FIX. The viewport loop re-issues each layer's bbox query on every
// (debounced) viewport emit. With no memory of prior failures, a persistently
// failing endpoint (a 400 shape mismatch, a 502 upstream outage like FEMA NFHL,
// a network error) gets re-fired on every pan/zoom — thousands of requests —
// until the browser connection pool is exhausted (ERR_INSUFFICIENT_RESOURCES)
// and the map goes black.
//
// This mirrors the resilience intent of the pre-library home-grown client's
// `bboxSupported` runtime feature-detection latch: once a layer's bbox query
// has failed hard, STOP issuing it for the session. The guard is per-layer, so
// a failing FEMA layer never suppresses working parcels and vice-versa. A
// successful response CLEARS the latch (transient blips self-heal on the next
// good response); a hard failure re-arms it.

/** Which HTTP outcomes trip the latch. 404 (no-coverage) does NOT — it is an
 *  honest "no data here", cheap, and legitimately varies by viewport. */
export function shouldSuppressAfter(state: LiveLayerState): boolean {
  return state.status === 'error'
}

export interface LiveGisGuard {
  /** True if this layer is latched off and its bbox query must be skipped. */
  isSuppressed(layer: LiveLayerKey): boolean
  /** The suppressed state to render for a latched layer (honest empty). */
  suppressedState(layer: LiveLayerKey): Extract<LiveLayerState, { status: 'suppressed' }>
  /** Fold a fetch outcome into the latch: arms on hard failure, clears on ok. */
  record(layer: LiveLayerKey, state: LiveLayerState): void
  /** Reset all latches (e.g. an explicit user "retry"). */
  reset(): void
}

/**
 * Create a session-scoped per-layer failure guard. Hold one instance per tile
 * (a ref) so it persists across viewport emits within a session but resets on
 * remount.
 */
export function createLiveGisGuard(): LiveGisGuard {
  const suppressed = new Map<LiveLayerKey, string>()
  return {
    isSuppressed: (layer) => suppressed.has(layer),
    suppressedState: (layer) => ({
      status: 'suppressed',
      message: suppressed.get(layer) ?? `${layer}: layer temporarily disabled after repeated failure`,
    }),
    record: (layer, state) => {
      if (state.status === 'ok' || state.status === 'no-coverage') {
        // A good (or honestly-empty) response self-heals a prior latch.
        suppressed.delete(layer)
        return
      }
      if (shouldSuppressAfter(state)) {
        const message = state.status === 'error' ? state.message : `${layer}: suppressed`
        suppressed.set(layer, message)
      }
    },
    reset: () => suppressed.clear(),
  }
}

/** Neutral parcel fill when no landUseCode is present in the viewport. */
const NEUTRAL_PARCEL_FILL = '#8aa2b8'

/** Categorical palette for landUseCode classes (cycled). */
const LAND_USE_PALETTE = [
  '#5b8dd6',
  '#5fb88a',
  '#d6a75b',
  '#b57bd6',
  '#d66f6f',
  '#5bc4d6',
  '#c9d65b',
  '#d65ba8',
]

/**
 * Data-driven parcel fill color: categorical by landUseCode where present in
 * the fetched collection, neutral otherwise.
 */
export function parcelFillColor(fc: FeatureCollectionLike | undefined): unknown {
  const codes: string[] = []
  for (const f of fc?.features ?? []) {
    const code = f.properties?.landUseCode
    if (typeof code === 'string' && code && !codes.includes(code)) codes.push(code)
    if (codes.length >= 24) break
  }
  if (!codes.length) return NEUTRAL_PARCEL_FILL
  const expr: unknown[] = ['match', ['to-string', ['get', 'landUseCode']]]
  codes.forEach((code, i) => {
    expr.push(code, LAND_USE_PALETTE[i % LAND_USE_PALETTE.length])
  })
  expr.push(NEUTRAL_PARCEL_FILL)
  return expr
}

/**
 * Compose the live OverlaySpec[] for the renderer. FEMA first so its fill
 * draws BELOW the parcel lines (reconcileOverlays adds layers in array
 * order); parcels are the interactive click/hover surface.
 */
export function toLiveOverlays(
  parcels: LiveLayerState,
  fema: LiveLayerState,
): LiveOverlaySpec[] {
  const specs: LiveOverlaySpec[] = []
  if (fema.status === 'ok' && fema.response.geojson) {
    specs.push({
      layerKey: LIVE_FEMA_KEY,
      provider: fema.response.provider,
      geojson: fema.response.geojson,
      paint: {
        'fill-color': [
          'match',
          ['get', 'FLD_ZONE'],
          'X', 'rgba(96,165,250,0.18)',
          'rgba(59,130,246,0.6)',
        ],
        'fill-opacity': 0.4,
        'line-color': 'rgba(59,130,246,0.55)',
        'line-width': 0.8,
      },
    })
  }
  if (parcels.status === 'ok' && parcels.response.geojson) {
    specs.push({
      layerKey: LIVE_PARCELS_KEY,
      provider: parcels.response.provider,
      geojson: parcels.response.geojson,
      interactive: true,
      paint: {
        'fill-color': parcelFillColor(parcels.response.geojson),
        'fill-opacity': 0.14,
        'line-color': '#7dd3fc',
        'line-width': 1.1,
      },
    })
  }
  return specs
}

/** What the parcel info card renders, extracted from a map click selection. */
export interface ParcelCardData {
  apn: string | null
  situsAddress: string | null
  owner: string | null
  landUseDescription: string | null
  county: string | null
  provider: string | null
  notSurveyGrade: boolean
  retrievedAt: string | null
  lat: number | null
  lng: number | null
}

/** Map a live-parcel ParcelSelection onto the info-card payload. */
export function selectionToCard(sel: ParcelSelection): ParcelCardData {
  const p = (sel.properties ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : v != null && typeof v === 'number' ? String(v) : null
  const countyName = str(p.countyName)
  const countyFips = str(p.countyFips)
  return {
    apn: str(p.apn),
    situsAddress: str(p.situsAddress) ?? (sel.address ?? null),
    owner: str(p.owner),
    landUseDescription: str(p.landUseDescription) ?? str(p.landUseCode),
    county: countyName ? (countyFips ? `${countyName} County (${countyFips})` : `${countyName} County`) : countyFips,
    provider: str(p.provider),
    notSurveyGrade: p.notSurveyGrade === true || p.notSurveyGrade === 'true',
    retrievedAt: str(p.retrievedAt),
    lat: typeof sel.lat === 'number' ? sel.lat : null,
    lng: typeof sel.lng === 'number' ? sel.lng : null,
  }
}
