import { useEffect, useMemo, useRef } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@hauska/tile-shell'
import { TileErrorBoundary } from '../TileErrorBoundary'

const baseUrl =
  import.meta.env.VITE_HAUSKA_MAP_URL ?? 'https://map.hauska.io/command-center'

// ─── SWAP SEAM ────────────────────────────────────────────────────
// MapSurface is the single import seam for the map renderer. Today it is the
// iframe embed of the external hauska-map command center, which centers on the
// parcel (lat/lng/apn) and renders SpatialProvider overlays via postMessage.
// This is the accepted fallback while @hauska/map-renderer is unpublished
// (npm view @hauska/map-renderer -> 404).
//   SWAP SEAM: replace <MapSurface/> below with <FloatingMap/> from
//   @hauska/map-renderer when that package publishes. The props (apn,
//   jurisdiction, lat, lng, overlays) are the intended renderer contract.
type MapSurfaceProps = {
  apn: string
  jurisdiction: string
  lat: number | null
  lng: number | null
  overlays: ReturnType<typeof useSpatial>['overlays']
}

function MapSurface({ apn, jurisdiction, lat, lng, overlays }: MapSurfaceProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const iframeSrc = useMemo(() => {
    const params = new URLSearchParams()
    if (apn) params.set('apn', apn)
    if (jurisdiction) params.set('jurisdiction', jurisdiction)
    if (lat != null) params.set('lat', String(lat))
    if (lng != null) params.set('lng', String(lng))
    params.set('mode', 'embed')
    const qs = params.toString()
    return qs ? `${baseUrl}?${qs}` : `${baseUrl}?mode=embed`
  }, [apn, jurisdiction, lat, lng])

  function postMapContext() {
    const frame = iframeRef.current
    if (!frame?.contentWindow) return
    for (const overlay of overlays) {
      frame.contentWindow.postMessage({ type: 'ADD_OVERLAY', overlay }, '*')
    }
    if (apn) {
      frame.contentWindow.postMessage({ type: 'SET_PARCEL', apn }, '*')
    }
  }

  useEffect(() => {
    postMapContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlays, apn, iframeSrc])

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      onLoad={postMapContext}
      style={{ flex: 1, border: 'none', width: '100%', minHeight: 0 }}
      title="Hauska Map"
      allow="*"
    />
  )
}

function MapTileInner() {
  const { engagement } = useEngagement()
  const { overlays } = useSpatial()

  const apn = engagement?.apn ?? ''
  const jurisdiction = engagement?.jurisdiction ?? ''
  const lat = engagement?.latitude ?? null
  const lng = engagement?.longitude ?? null

  return (
    <div
      data-testid="map-tile"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <TileStatusBanner status="live" label="Map" />
      {!import.meta.env.VITE_HAUSKA_MAP_URL ? (
        <div
          style={{
            padding: 'var(--h-space-sm)',
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
            flexShrink: 0,
          }}
        >
          Set VITE_HAUSKA_MAP_URL in .env.local to use the local hauska-map.
        </div>
      ) : null}
      <MapSurface
        apn={apn}
        jurisdiction={jurisdiction}
        lat={lat}
        lng={lng}
        overlays={overlays}
      />
      {!engagement ? (
        <p
          style={{
            fontSize: 11,
            padding: 'var(--h-space-xs) var(--h-space-sm)',
            color: 'var(--h-text-muted)',
            margin: 0,
            flexShrink: 0,
          }}
        >
          Select an engagement to center the map on parcel context.
        </p>
      ) : lat != null && lng != null ? (
        <p
          style={{
            fontSize: 10,
            color: 'var(--h-text-muted)',
            margin: 0,
            padding: 'var(--h-space-xs)',
            flexShrink: 0,
          }}
        >
          Center: {lat.toFixed(5)}, {lng.toFixed(5)}
          {apn ? ` · APN ${apn}` : ''}
        </p>
      ) : null}
    </div>
  )
}

export function MapTile() {
  return (
    <TileErrorBoundary label="Map">
      <MapTileInner />
    </TileErrorBoundary>
  )
}
