import { useMemo } from 'react'
import { FloatingMap, type OverlaySpec as MapOverlaySpec, type ParcelSelection } from '@hauska/map-renderer'
import '@hauska/map-renderer/styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEngagement, useSpatial, TileStatusBanner } from '@hauska/tile-shell'
import type { OverlaySpec } from '@hauska/tile-shell'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { PropertyBriefTile } from '../property-intel/PropertyBriefTile'

// The map renders through @hauska/map-renderer (ADR-024 shared-surface package),
// replacing the prior iframe embed of the external hauska-map command center.
// floating={false} yields a plain filled container the tile positions itself.
// The parcel prop drives the flyTo recenter on the shared active parcel.
//
// SETTER #3 (map-click): FloatingMap.onParcelSelect fires when the operator
// clicks a parcel/zoning feature. We route it into the ONE shared active-parcel
// context via setActiveParcel, so the property brief, hazard, setbacks, and
// every address-scoped tile react to a map click.
//
// MAP-CLICK -> PROPERTY SUMMARY: on a parcel selection we surface a compact
// PropertyBriefTile (card mode) as the summary — reusing the tile, not a
// separate module.

// OVERLAY SEAM (0.1.1): map the SpatialProvider overlay stack onto the map
// renderer's OverlaySpec[] and pass it through. In map-renderer @0.1.0 the
// `overlays` prop is reserved and unwired (no setOverlays on the renderer), so
// this does not draw yet — it matches prior behavior (the old iframe posted
// ADD_OVERLAY messages the console never handled). When @hauska/map-renderer
// @0.1.1 ships setOverlays, bumping the dependency lights these up with NO tile
// change: the prop is already passed and the mapping is already correct.
function toMapOverlays(overlays: OverlaySpec[]): MapOverlaySpec[] {
  return overlays
    .filter((o) => o.geojson)
    .map((o) => ({
      // SpatialProvider overlays carry a `kind` naming the layer they feed
      // (e.g. "contours", "flow-lines", "flood-extent"); use it as the map
      // registry layerKey. `id` is the stable overlay identity.
      layerKey: o.kind || o.id,
      geojson: o.geojson,
      visible: true,
      ...(o.opacity != null ? { paint: { 'fill-opacity': o.opacity } } : {}),
    }))
}

function MapTileInner() {
  const { activeParcel, setActiveParcel } = useEngagement()
  const { overlays } = useSpatial()

  const { apn, jurisdiction, lat, lng } = activeParcel

  const center = useMemo(
    () => (lat != null && lng != null ? { latitude: lat, longitude: lng } : undefined),
    [lat, lng],
  )

  const parcel = useMemo(
    () => (lat != null && lng != null ? { apn: apn ?? undefined, lat, lng } : null),
    [apn, lat, lng],
  )

  const mapOverlays = useMemo(() => toMapOverlays(overlays), [overlays])

  const hasParcel = lat != null && lng != null

  function handleParcelSelect(sel: ParcelSelection) {
    if (sel.lat == null || sel.lng == null) return
    // Map-click sets the shared active parcel (setter #3). Preserve the engagement
    // scope if one is active by not clearing engagementId here (setActiveParcel
    // only overwrites the fields we pass).
    setActiveParcel({
      apn: sel.apn ?? null,
      address: sel.address ?? null,
      lat: sel.lat,
      lng: sel.lng,
    })
  }

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
        overlays={mapOverlays}
        onParcelSelect={handleParcelSelect}
        style={{ flex: 1, minHeight: 0 }}
      />
      {!hasParcel ? (
        <p
          style={{
            fontSize: 11,
            padding: 'var(--h-space-xs) var(--h-space-sm)',
            color: 'var(--h-text-muted)',
            margin: 0,
            flexShrink: 0,
          }}
        >
          Select an engagement, search an address, or click a parcel to center the map.
        </p>
      ) : (
        <div style={{ flexShrink: 0, borderTop: '1px solid var(--h-border-subtle)' }}>
          <p
            style={{
              fontSize: 10,
              color: 'var(--h-text-muted)',
              margin: 0,
              padding: 'var(--h-space-xs)',
            }}
          >
            Center: {lat!.toFixed(5)}, {lng!.toFixed(5)}
            {apn ? ` · APN ${apn}` : ''}
            {overlays.length
              ? ` · ${overlays.length} overlay${overlays.length === 1 ? '' : 's'} pending`
              : ''}
          </p>
          {/* MAP-CLICK -> PROPERTY SUMMARY: compact brief for the selected parcel. */}
          <PropertyBriefTile mode="card" />
        </div>
      )}
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
