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
// Parcel feature properties: parcel_node_id, apn, situsAddress, owner,
// landUseCode?, landUseDescription?, countyFips, countyName, provider,
// retrievedAt, notSurveyGrade. FEMA feature properties: FLD_ZONE, SFHA_TF, ...
//
// parcel_node_id is the CANONICAL parcel id — `{county_fips}:{normalizeCadPropId
// (prop_id)}` — stamped by the backend map-data route (brokerageTxParcels.ts /
// txgioParcelStore.ts). It is carried through this library UNTOUCHED: the geojson
// FeatureCollection threads straight into the OverlaySpec (overlayForLayer does
// not rebuild feature props), and selectionToCard surfaces it on the card as
// `parcelNodeId` so the frontend can key MapLibre feature-state highlight on the
// canonical id (with `apn` kept as the back-compat fallback).

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

/**
 * The live GIS layers the loader owns. `parcels` + `fema` were the original
 * two; the five federal/state layers are the REAL, bbox-fetchable layers the
 * server's /map-data/gis-layer POST allowlist already accepts (see
 * artifacts/api-server .../brokerageGisFederalLayers.ts + the GIS_LAYER_KEYS
 * allowlist). No backend change is needed to fetch any of these — the proxy
 * exact-match allowlist already lists all seven. NONE of these is a
 * fixture/synthetic composite (no buildable-envelope / constraint-density /
 * motivated-seller / oz-crossfilter): every key here returns real ArcGIS/USGS
 * GeoJSON from a public source.
 */
export type LiveLayerKey =
  | 'parcels'
  | 'fema'
  | 'ssurgo-soils'
  | 'groundwater'
  | 'mud-pid'
  | 'edwards-aquifer'
  | 'texas-rrc'

/** Every live layer key, in draw order (coarser/context below, parcels on top). */
export const LIVE_LAYER_KEYS: LiveLayerKey[] = [
  'edwards-aquifer',
  'ssurgo-soils',
  'mud-pid',
  'texas-rrc',
  'groundwater',
  'fema',
  'parcels',
]

/** Overlay layerKeys the live loader owns on the map (renderer source/layer ids). */
export const LIVE_PARCELS_KEY = 'live-parcels'
export const LIVE_FEMA_KEY = 'live-fema'
export const LIVE_SSURGO_KEY = 'live-ssurgo'
export const LIVE_GROUNDWATER_KEY = 'live-groundwater'
export const LIVE_MUDPID_KEY = 'live-mud-pid'
export const LIVE_EDWARDS_KEY = 'live-edwards'
export const LIVE_RRC_KEY = 'live-rrc'

/** Map a LiveLayerKey to the renderer overlay layerKey it draws under. */
export const OVERLAY_KEY_FOR_LAYER: Record<LiveLayerKey, string> = {
  parcels: LIVE_PARCELS_KEY,
  fema: LIVE_FEMA_KEY,
  'ssurgo-soils': LIVE_SSURGO_KEY,
  groundwater: LIVE_GROUNDWATER_KEY,
  'mud-pid': LIVE_MUDPID_KEY,
  'edwards-aquifer': LIVE_EDWARDS_KEY,
  'texas-rrc': LIVE_RRC_KEY,
}

/** Parcels are bbox-capped (~200 features upstream); below this zoom we show
 *  a coarse "zoom in for parcel detail" state instead of hammering the API with
 *  huge viewports. See layersForZoom + coarseAffordanceForZoom. */
export const MIN_PARCEL_ZOOM = 14
/** FEMA flood polygons are coarser; fetchable a bit wider out. This is also the
 *  floor at which the map keeps rendering an HONEST coarse (FEMA-only) state
 *  when zoomed out past parcel detail — never a blank map. */
export const MIN_FEMA_ZOOM = 11
/** SSURGO soils / Edwards aquifer / MUD-PID are area polygons that read well a
 *  little wider out than parcels but not at metro scale. */
export const MIN_SOILS_ZOOM = 12
export const MIN_MUDPID_ZOOM = 11
export const MIN_EDWARDS_ZOOM = 10
/** RRC wells/pipelines + NWIS groundwater points are dense; keep them near-in so
 *  the point clouds stay legible and the bbox stays cheap. */
export const MIN_RRC_ZOOM = 12
export const MIN_GROUNDWATER_ZOOM = 12

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

/**
 * Which live layers a given zoom is ALLOWED to request. This is the per-layer
 * min-zoom gate (keeps a metro-wide viewport from firing a 10k-feature bbox).
 *
 * NOTE: this returns the layers the loader MAY fetch; the consumer intersects it
 * with the user's visibility set (the toggle UI) so a layer is fetched only when
 * it is both zoom-eligible AND toggled on. FEMA at MIN_FEMA_ZOOM is the coarsest
 * always-available context layer — see coarseAffordanceForZoom for what keeps
 * the map honest below MIN_PARCEL_ZOOM.
 */
export function layersForZoom(zoom: number): LiveLayerKey[] {
  const layers: LiveLayerKey[] = []
  if (zoom >= MIN_EDWARDS_ZOOM) layers.push('edwards-aquifer')
  if (zoom >= MIN_MUDPID_ZOOM) layers.push('mud-pid')
  if (zoom >= MIN_FEMA_ZOOM) layers.push('fema')
  if (zoom >= MIN_SOILS_ZOOM) layers.push('ssurgo-soils')
  if (zoom >= MIN_RRC_ZOOM) layers.push('texas-rrc')
  if (zoom >= MIN_GROUNDWATER_ZOOM) layers.push('groundwater')
  if (zoom >= MIN_PARCEL_ZOOM) layers.push('parcels')
  return layers
}

// ---------------------------------------------------------------------------
// LOD honest-empty: never a blank map when zoomed out
// ---------------------------------------------------------------------------
//
// THE ZOOM-OUT FIX. The old rule returned [] below zoom 11, so a zoomed-out
// viewport fetched nothing and the map read as "no data here" (an empty tan/black
// canvas). That is dishonest — data DOES exist, it is just too dense to fetch at
// that scale. The cheap correct fix (no backend change, no server-side simplify):
//
//   * KEEP fetching the coarse context layers that are already fetchable wide-out
//     (FEMA to zoom 11, Edwards aquifer to zoom 10) so something real still draws.
//   * Below MIN_PARCEL_ZOOM, surface an HONEST affordance describing what is
//     coarse and how to see detail ("Zoom in for parcel detail"), rather than
//     rendering nothing. The consumer renders this as a small map chrome note.
//
// So at ANY zoom the user sees either real coarse geometry, or an honest note —
// never a bare empty map that reads as an absence of data.

export interface CoarseAffordance {
  /** True when the current zoom is below the parcel-detail floor. */
  coarse: boolean
  /** Honest one-line note for the map chrome. Empty when not coarse. */
  note: string
  /** The context layers still fetchable at this zoom (for the honest indicator). */
  availableLayers: LiveLayerKey[]
}

/**
 * Describe the honest coarse state for a zoom. Below MIN_PARCEL_ZOOM the map
 * cannot show parcel geometry cheaply, so it reports which coarser layers ARE
 * still live (FEMA / aquifer / districts) and prompts a zoom-in for detail. At
 * or above MIN_PARCEL_ZOOM this is the non-coarse (full-detail) state.
 */
export function coarseAffordanceForZoom(zoom: number): CoarseAffordance {
  const availableLayers = layersForZoom(zoom)
  if (zoom >= MIN_PARCEL_ZOOM) {
    return { coarse: false, note: '', availableLayers }
  }
  const context = availableLayers.filter((l) => l !== 'parcels')
  const note = context.length
    ? 'Zoom in for parcel detail — showing coarse layers only'
    : 'Zoom in to load map data for this area'
  return { coarse: true, note, availableLayers }
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
 * Data-driven parcel fill color, categorical over a parcel property. Shared by
 * the land-use choropleth (`landUseCode`, the default) and the color-by-zoning
 * variant (`zoningCode`). Parcels carry BOTH from enrichParcelsWithZoning, so
 * zoning is a paint variant, not a separate fetch.
 */
function parcelCategoricalFill(
  fc: FeatureCollectionLike | undefined,
  property: string,
): unknown {
  const codes: string[] = []
  for (const f of fc?.features ?? []) {
    const code = f.properties?.[property]
    if (typeof code === 'string' && code && !codes.includes(code)) codes.push(code)
    if (codes.length >= 24) break
  }
  if (!codes.length) return NEUTRAL_PARCEL_FILL
  const expr: unknown[] = ['match', ['to-string', ['get', property]]]
  codes.forEach((code, i) => {
    expr.push(code, LAND_USE_PALETTE[i % LAND_USE_PALETTE.length])
  })
  expr.push(NEUTRAL_PARCEL_FILL)
  return expr
}

/**
 * Data-driven parcel fill color: categorical by landUseCode where present in
 * the fetched collection, neutral otherwise.
 */
export function parcelFillColor(fc: FeatureCollectionLike | undefined): unknown {
  return parcelCategoricalFill(fc, 'landUseCode')
}

/**
 * Color-by-ZONING parcel fill variant: categorical by parcel `zoningCode`
 * (carried on parcels by enrichParcelsWithZoning), neutral where absent. This
 * is the parallel of parcelFillColor for the "color by zoning" toggle — same
 * shape, different property, so the consumer can swap the parcel fill paint
 * without a second fetch.
 */
export function parcelZoningFillColor(
  fc: FeatureCollectionLike | undefined,
): unknown {
  return parcelCategoricalFill(fc, 'zoningCode')
}

/**
 * Per-layer paint for the FIVE federal/state layers + FEMA. Colors are dark,
 * saturated strokes readable on the warm-light "paper map" basemap the Brief
 * uses (a pale-stroke palette washes out on tan). Each layer gets a distinct
 * hue so a multi-layer view stays legible:
 *   fema            — blue flood bands
 *   ssurgo-soils    — foundation-risk choropleth (green→amber→red by risk band)
 *   groundwater     — teal wells (points)
 *   mud-pid         — magenta districts (polygons)
 *   edwards-aquifer — purple recharge/contributing (polygons)
 *   texas-rrc       — brown/orange wells (points) + pipelines (lines)
 * reconcileOverlays auto-detects the geometry family per overlay and creates the
 * matching -fill / -line / -circle sublayer, reading these paint keys.
 */
function paintForLayer(key: LiveLayerKey, fc: FeatureCollectionLike): Record<string, unknown> {
  switch (key) {
    case 'fema':
      return {
        'fill-color': [
          'match',
          ['get', 'FLD_ZONE'],
          'X', 'rgba(37,99,235,0.14)',
          'rgba(29,78,216,0.5)',
        ],
        'fill-opacity': 0.32,
        'line-color': '#1d4ed8',
        'line-width': 1.1,
      }
    case 'ssurgo-soils':
      // foundationRiskScore (1 low → 4 high) is enriched onto every feature
      // server-side. Choropleth green → amber → red so soil foundation risk
      // reads at a glance.
      return {
        'fill-color': [
          'match',
          ['to-string', ['get', 'foundationRiskBand']],
          'high', 'rgba(153,27,27,0.42)',
          'moderate', 'rgba(180,83,9,0.36)',
          'low', 'rgba(21,128,61,0.30)',
          'rgba(120,113,108,0.30)',
        ],
        'fill-opacity': 0.5,
        'line-color': '#7c2d12',
        'line-width': 0.7,
      }
    case 'groundwater':
      // NWIS monitoring wells — points.
      return {
        'circle-color': '#0f766e',
        'circle-radius': 5,
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      }
    case 'mud-pid':
      // MUD/PID/PUD special districts — polygons.
      return {
        'fill-color': 'rgba(162,28,175,0.20)',
        'fill-opacity': 0.4,
        'line-color': '#86198f',
        'line-width': 1.2,
      }
    case 'edwards-aquifer':
      // Recharge vs contributing tagged by edwardsZone — two-tone purple.
      return {
        'fill-color': [
          'match',
          ['to-string', ['get', 'edwardsZone']],
          'recharge', 'rgba(109,40,217,0.30)',
          'contributing', 'rgba(147,51,234,0.18)',
          'rgba(126,34,206,0.22)',
        ],
        'fill-opacity': 0.45,
        'line-color': '#6d28d9',
        'line-width': 1,
      }
    case 'texas-rrc':
      // Wells (points) + pipelines (lines), tagged rrcAsset. The renderer draws
      // both a -circle and a -line sublayer from the mixed FeatureCollection.
      return {
        'circle-color': '#9a3412',
        'circle-radius': 4,
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 0.8,
        'line-color': '#c2410c',
        'line-width': 1.4,
      }
    case 'parcels':
    default:
      return {
        'fill-color': parcelFillColor(fc),
        'fill-opacity': 0.14,
        'line-color': '#7dd3fc',
        'line-width': 1.1,
      }
  }
}

/**
 * Compose ONE live OverlaySpec from a resolved layer state, or null when the
 * layer is not drawable (not ok, or no geojson). Parcels are the interactive
 * click/hover surface; everything else is passive context.
 */
export function overlayForLayer(
  key: LiveLayerKey,
  state: LiveLayerState,
): LiveOverlaySpec | null {
  if (state.status !== 'ok' || !state.response.geojson) return null
  const spec: LiveOverlaySpec = {
    layerKey: OVERLAY_KEY_FOR_LAYER[key],
    provider: state.response.provider,
    geojson: state.response.geojson,
    paint: paintForLayer(key, state.response.geojson),
  }
  if (key === 'parcels') spec.interactive = true
  return spec
}

/**
 * Compose the live OverlaySpec[] for the renderer from a per-layer state map.
 * Draw order follows LIVE_LAYER_KEYS (context polygons below, points/parcels on
 * top) so reconcileOverlays stacks them legibly (it adds layers in array order).
 *
 * Back-compat: also accepts the legacy positional call
 * `toLiveOverlays(parcels, fema)` — the shape the pre-extension Brief and the
 * library's own tests use. A second positional arg (or any non-Map first arg) is
 * treated as the parcels+fema pair.
 */
export function toLiveOverlays(
  statesOrParcels: Partial<Record<LiveLayerKey, LiveLayerState>> | LiveLayerState,
  fema?: LiveLayerState,
): LiveOverlaySpec[] {
  // Legacy positional form: (parcels, fema).
  if (fema !== undefined || isLiveLayerState(statesOrParcels)) {
    const parcels = statesOrParcels as LiveLayerState
    const states: Partial<Record<LiveLayerKey, LiveLayerState>> = {
      parcels,
      ...(fema ? { fema } : {}),
    }
    return composeOverlays(states)
  }
  return composeOverlays(statesOrParcels as Partial<Record<LiveLayerKey, LiveLayerState>>)
}

function isLiveLayerState(v: unknown): v is LiveLayerState {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { status?: unknown }).status === 'string'
  )
}

function composeOverlays(
  states: Partial<Record<LiveLayerKey, LiveLayerState>>,
): LiveOverlaySpec[] {
  const specs: LiveOverlaySpec[] = []
  for (const key of LIVE_LAYER_KEYS) {
    const state = states[key]
    if (!state) continue
    const spec = overlayForLayer(key, state)
    if (spec) specs.push(spec)
  }
  return specs
}

/** What the parcel info card renders, extracted from a map click selection. */
export interface ParcelCardData {
  /**
   * Canonical parcel id `{county_fips}:{normalizeCadPropId(prop_id)}` when the
   * backend stamped it on the feature; null otherwise. This is the id the
   * frontend keys MapLibre feature-state highlight on. `apn` stays as the
   * back-compat fallback for features that predate the canonical id.
   */
  parcelNodeId: string | null
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
    // Prefer the canonical parcel_node_id the backend stamps; snake_case is the
    // wire key on the feature props. Kept alongside apn (never replacing it) so a
    // feature without the canonical id still resolves on apn.
    parcelNodeId: str(p.parcel_node_id),
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

// ---------------------------------------------------------------------------
// Buildable envelope — a DERIVED report overlay (NOT a live bbox layer)
// ---------------------------------------------------------------------------
//
// The buildable envelope is the parcel polygon inset by its front/side/rear
// setbacks (see api-server .../buildableEnvelope + the
// GET /place/:placeKey/buildable-envelope route). It is DERIVED, not a
// bbox-fetchable layer, so it is deliberately NOT a LiveLayerKey — it does not
// go through fetchGisLayer / the /map-data/gis-layer proxy allowlist. The Brief
// fetches the derivation once (per place) and draws it as a report overlay.
//
// HONESTY styling (commitment #1): a WRONG envelope drawn confidently is worse
// than none. So the paint is confidence-aware — a high-confidence envelope
// reads as a solid green buildable area; an APPROXIMATE one reads as an amber,
// dashed, more-transparent shape that visually signals "estimate, verify". The
// empty (no-buildable-area) case draws nothing (the disclosure carries it).

/** Renderer overlay layerKey the buildable envelope draws under. */
export const BUILDABLE_ENVELOPE_KEY = 'buildable-envelope'

/** The buildable-envelope feature properties the derivation route emits. */
export interface BuildableEnvelopeFeatureProps {
  kind?: string
  approximate?: boolean
  notSurveyGrade?: boolean
  disclosure?: string
  citationUrl?: string
  buildableAreaSqFt?: number
  buildableAreaPct?: number
  maxLotCoveragePct?: number | null
  maxHeightFt?: number | null
  maxFootprintSqFt?: number | null
  setbacks?: { front_ft: number; side_ft: number; rear_ft: number; district: string }
  edgeSignal?: string
  edgeNote?: string
  districtNote?: string
  emptyReason?: string
}

/** The `payload` shape of the buildable-envelope derivation response. */
export interface BuildableEnvelopePayload {
  geojson?: FeatureCollectionLike
  approximate?: boolean
  empty?: boolean
  citationUrl?: string
  district?: string
}

/**
 * Paint for the buildable envelope, confidence-aware. High-confidence: solid
 * green buildable area. Approximate: amber, dashed border, lower opacity — a
 * visual "estimate, verify" signal so a user never mistakes it for a survey.
 */
export function buildableEnvelopePaint(approximate: boolean): Record<string, unknown> {
  if (approximate) {
    return {
      'fill-color': 'rgba(180,83,9,0.16)', // amber
      'fill-opacity': 0.35,
      'line-color': '#b45309',
      'line-width': 1.6,
      'line-dasharray': [2, 2],
    }
  }
  return {
    'fill-color': 'rgba(21,128,61,0.22)', // green
    'fill-opacity': 0.45,
    'line-color': '#15803d',
    'line-width': 1.8,
  }
}

/**
 * Compose the buildable-envelope OverlaySpec from the derivation response
 * payload, or null when there is no drawable geometry (empty envelope, or the
 * derivation returned no polygon feature). The overlay is passive (not the
 * interactive parcel surface); the Brief renders the disclosure + citation in
 * chrome, and the feature properties carry them for a click handler.
 */
export function buildableEnvelopeOverlay(
  payload: BuildableEnvelopePayload | null | undefined,
): LiveOverlaySpec | null {
  if (!payload || !payload.geojson) return null
  const features = payload.geojson.features ?? []
  const drawable = features.filter(
    (f) => f && f.geometry != null && typeof f.geometry === 'object',
  )
  if (!drawable.length) return null
  const approximate = payload.approximate === true
  return {
    layerKey: BUILDABLE_ENVELOPE_KEY,
    provider: 'hauska:buildable-envelope',
    geojson: { type: 'FeatureCollection', features: drawable },
    paint: buildableEnvelopePaint(approximate),
  }
}

/** What the buildable-envelope info card renders (disclosure + sizing + cite). */
export interface BuildableEnvelopeCard {
  approximate: boolean
  empty: boolean
  disclosure: string | null
  citationUrl: string | null
  district: string | null
  buildableAreaSqFt: number | null
  buildableAreaPct: number | null
  maxFootprintSqFt: number | null
  maxHeightFt: number | null
  edgeSignal: string | null
}

/** Extract the buildable-envelope card fields from the derivation payload. */
export function buildableEnvelopeCard(
  payload: BuildableEnvelopePayload | null | undefined,
): BuildableEnvelopeCard | null {
  if (!payload) return null
  const feat = payload.geojson?.features?.[0]
  const props = (feat?.properties ?? {}) as BuildableEnvelopeFeatureProps
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null
  return {
    approximate: payload.approximate === true || props.approximate === true,
    empty: payload.empty === true,
    disclosure: str(props.disclosure),
    citationUrl: str(props.citationUrl) ?? str(payload.citationUrl),
    district: str(payload.district) ?? str(props.setbacks?.district),
    buildableAreaSqFt: num(props.buildableAreaSqFt),
    buildableAreaPct: num(props.buildableAreaPct),
    maxFootprintSqFt: num(props.maxFootprintSqFt),
    maxHeightFt: num(props.maxHeightFt),
    edgeSignal: str(props.edgeSignal),
  }
}
