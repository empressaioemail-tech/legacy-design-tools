import { useMemo } from 'react'
import { FloatingMap } from '@hauska/map-renderer'
import '@hauska/map-renderer/styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEngagement, useSpatial, TileStatusBanner } from '@hauska/tile-shell'
import { TileErrorBoundary } from '../TileErrorBoundary'

// The map renders through @hauska/map-renderer (ADR-024 shared-surface package),
// replacing the prior iframe embed of the external hauska-map command center.
// floating={false} yields a plain filled container the tile positions itself.
// The parcel prop drives the flyTo recenter on the engagement parcel.
//
// Overlay rendering: FloatingMap's `overlays` prop is reserved and not yet wired
// in the renderer (map-renderer @0.1.0). SpatialProvider overlays therefore do
// not draw on the map yet; this matches prior behavior (the old iframe posted
// ADD_OVERLAY messages that the console never handled). Live overlays land when
// map-renderer ships setOverlays (tracked as the 0.1.1 follow-up).

function MapTileInner() {
  const { engagement } = useEngagement()
  const { overlays } = useSpatial()

  const apn = engagement?.apn ?? ''
  const jurisdiction = engagement?.jurisdiction ?? ''
  const lat = engagement?.latitude ?? null
  const lng = engagement?.longitude ?? null

  const center = useMemo(
    () => (lat != null && lng != null ? { latitude: lat, longitude: lng } : undefined),
    [lat, lng],
  )

  const parcel = useMemo(
    () => (lat != null && lng != null ? { apn, lat, lng } : null),
    [apn, lat, lng],
  )

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
      <FloatingMap
        floating={false}
        center={center}
        parcel={parcel}
        address={jurisdiction || undefined}
        style={{ flex: 1, minHeight: 0 }}
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
          {overlays.length ? ` · ${overlays.length} overlay${overlays.length === 1 ? '' : 's'} pending` : ''}
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
