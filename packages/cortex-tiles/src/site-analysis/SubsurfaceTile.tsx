import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'
import { fetchSubsurface, type GeoJsonFC } from './siteReports'

// ─── SSURGO map overlay (foundation-risk choropleth) ────────────────
//
// The subsurface REPORT (usdaSsurgoSoilsAdapter, the point-query path the
// tile's fetchSubsurface hits) returns scalar soil attributes for the parcel
// point — mukey, foundationRiskScore, hydrologic soil group, depths — but NO
// polygon geometry. So, unlike the Drainage/Hydrology/Topography tiles whose
// report result already carries a *GeoJson field, the map overlay for SSURGO
// has to come from the SEPARATE SDA WFS polygon path.
//
// That polygon path is the SAME real USDA source the brokerage map mesh uses:
//   POST {baseUrl}/brokerage/v1/map-data/gis-layer  { layer: 'ssurgo-soils', bbox }
// (server handler: artifacts/api-server/src/routes/brokerageMapData.ts, which
// calls queryFederalGisLayerGeoJson -> fetchSsurgoWfsPolygons in
// brokerageGisFederalLayers.ts). It returns a FeatureCollection of map-unit
// polygons where every feature is enriched (enrichSsurgoGeoJson) with a
// `foundationRiskScore` (1..5) and a `foundationRiskBand` ("low"|"moderate"
// |"high") — the exact fields a foundation-risk choropleth keys on.
//
// We do NOT reuse fetchGisLayer() from ../map/liveGis: its `layer` param is
// typed to the live-map layer union ('parcels' | 'fema') only, and widening
// that published signature is the render-side owner's change. This tile owns
// the pushOverlay; the liveGis.ts render-side paint for the 'ssurgo-soils'
// overlay-kind is handed off to the cortex-tiles publisher (see PR notes).
//
// bbox: the report is engagement/point-keyed, so we derive a small square
// window around the parcel point. Real geometry from the real endpoint — no
// fabricated features; when the window has no mapped soils or the endpoint is
// unreachable, we surface that honestly and push nothing.

/** Overlay-kind emitted for the SSURGO soils / foundation-risk choropleth. */
export const SSURGO_OVERLAY_KIND = 'ssurgo-soils'
export const SSURGO_OVERLAY_ID = 'subsurface-ssurgo'

/** Half-width of the derived soils viewport, in degrees (~1.2km at TX lat). */
const SSURGO_BBOX_HALF_DEG = 0.011

interface SsurgoBbox {
  west: number
  south: number
  east: number
  north: number
}

/** A square bbox centered on the parcel point. Finite inputs only. */
export function bboxAroundPoint(
  lat: number,
  lng: number,
  halfDeg = SSURGO_BBOX_HALF_DEG,
): SsurgoBbox {
  return {
    west: lng - halfDeg,
    south: lat - halfDeg,
    east: lng + halfDeg,
    north: lat + halfDeg,
  }
}

type SsurgoLayerFetch =
  | { status: 'ok'; geojson: GeoJsonFC; featureCount: number }
  | { status: 'no-coverage'; detail?: string }
  | { status: 'error'; message: string }

/**
 * POST the ssurgo-soils gis-layer for a bbox. Mirrors the strict-clean request
 * shape the server's exact-match POST allowlist expects (`{ layer, bbox }`,
 * server GIS_BBOX_BODY is `.strict()`), attaching the same bearer auth the
 * plan-review report fetchers use. React-free; raw fetch (or injected).
 */
export async function fetchSsurgoSoilsLayer(
  baseUrl: string,
  bbox: SsurgoBbox,
  opts?: {
    getToken?: () => string | Promise<string>
    signal?: AbortSignal
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  },
): Promise<SsurgoLayerFetch> {
  const doFetch = opts?.fetchImpl ?? ((input, init) => fetch(input, init))
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.getToken) {
    const token = await opts.getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await doFetch(
      `${baseUrl.replace(/\/$/, '')}/brokerage/v1/map-data/gis-layer`,
      {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ layer: SSURGO_OVERLAY_KIND, bbox }),
        signal: opts?.signal,
      },
    )
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    return {
      status: 'error',
      message: (err as Error)?.message || 'network error',
    }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON handled by status below */
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
    return { status: 'error', message: detail }
  }

  const geojson = rec.geojson as GeoJsonFC | undefined
  if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    return { status: 'no-coverage', detail: 'No SSURGO soil polygons in this viewport.' }
  }
  return { status: 'ok', geojson, featureCount: geojson.features.length }
}

function SubsurfaceTileInner() {
  const client = useCortexClient()
  const { engagementId, activeParcel, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [overlayNote, setOverlayNote] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setOverlayNote(null)
    try {
      // Single source of truth: the pure fetchSubsurface function.
      const state = await fetchSubsurface(
        client.config.baseUrl,
        { engagementId },
        undefined,
        { getToken: client.config.getToken },
      )
      if (state.status === 'unavailable') {
        setError(state.detail ?? 'USDA endpoint unreachable')
        setEngagementReportResult('subsurface', {
          status: 'error',
          error: 'unavailable',
        })
        return
      }
      if (state.status === 'error') {
        setError(state.message)
        return
      }
      if (state.status === 'not-run') {
        setError('No subsurface result recorded yet — retry.')
        return
      }
      setResult(state.result)
      setEngagementReportResult('subsurface', {
        status: 'ok',
        result: state.result,
      })

      // Map overlay: the point report carries no geometry, so fetch the real
      // SSURGO map-unit polygons for a window around the parcel and push the
      // foundation-risk choropleth onto the shared spatial stack.
      const lat = activeParcel.lat
      const lng = activeParcel.lng
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        setOverlayNote(
          'Soil data ran, but the parcel is not geocoded — no map overlay pushed.',
        )
        return
      }
      const layer = await fetchSsurgoSoilsLayer(
        client.config.baseUrl,
        bboxAroundPoint(lat, lng),
        { getToken: client.config.getToken },
      )
      if (layer.status === 'ok') {
        // SEAM: kind === map-renderer OverlaySpec.layerKey (MapTile.toMapOverlays).
        // Feature properties carry foundationRiskBand / foundationRiskScore for
        // the choropleth paint (owned by liveGis.ts on the render side).
        pushOverlay({
          id: SSURGO_OVERLAY_ID,
          kind: SSURGO_OVERLAY_KIND,
          label: 'SSURGO foundation-risk soils',
          geojson: layer.geojson,
          opacity: 0.45,
        })
        setOverlayNote(
          `${layer.featureCount} soil map unit${layer.featureCount === 1 ? '' : 's'} · pushed to Map overlay stack.`,
        )
      } else if (layer.status === 'no-coverage') {
        setOverlayNote(
          layer.detail ?? 'No SSURGO soil polygons mapped around this parcel.',
        )
      } else {
        setOverlayNote(`Soil polygons unavailable: ${layer.message}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Subsurface run failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm)',
      }}
    >
      {error ? (
        <TileStatusBanner
          status="degraded"
          label="Subsurface Suitability"
          reason={error}
        />
      ) : (
        <TileStatusBanner status="live" label="Subsurface Suitability" />
      )}
      <button
        type="button"
        data-testid="subsurface-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run SSURGO subsurface'}
      </button>
      {overlayNote ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-success)' }}>
          {overlayNote}
        </span>
      ) : null}
      {error ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </span>
      ) : null}
      {result ? (
        <pre
          style={{
            fontSize: 10,
            overflow: 'auto',
            maxHeight: 160,
            background: 'var(--h-surface-2)',
            padding: 'var(--h-space-sm)',
            borderRadius: 'var(--h-radius-sm)',
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

export function SubsurfaceTile() {
  return (
    <TileErrorBoundary label="Subsurface Suitability">
      <SubsurfaceTileInner />
    </TileErrorBoundary>
  )
}
