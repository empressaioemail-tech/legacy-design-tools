// packages/cortex-tiles/src/map/LiveMapTile.tsx
//
// The LIVE Map tile, PROMOTED into @empressaio/cortex-tiles from the command
// center's local override so every consumer (command center, Property Brief,
// the Brief extension, future apps) gets the SAME real map instead of the
// fixture-only MapTile. The live map was the original library tile and the
// reason the library exists; this restores it to the published library where it
// belongs.
//
// What it adds over the (retained) fixture-only MapTile:
//   - Viewport loader: on map load + debounced moveend/zoomend, POSTs the
//     current bbox to the cortex proxy (/brokerage/v1/map-data/gis-layer) for
//     `parcels` + `fema` and renders them as live overlays. The base URL comes
//     from useCortexClient() (no app dependency).
//   - Honest states: zoom-in hint below MIN_PARCEL_ZOOM, truncated chip,
//     no-coverage empty state on 404, named error chips on failure -- never a
//     silent fixture fallback.
//   - Fixture layers default OFF and are watermarked FIXTURE when toggled on.
//   - Parcel click -> info card (situsAddress / APN / owner / land use /
//     county + provider / not-survey-grade attribution). The card's actions are
//     INJECTED by the consumer (onRunBrief / onSiteAnalysis) so the library tile
//     carries no app-specific panel/deep-link coupling; when an action is not
//     provided its button is hidden (no dead buttons).
//   - Report overlay stack: overlays pushed by the report tiles (topography
//     contours, drainage/hydrology flow lines) via useSpatial().pushOverlay draw
//     ON TOP of the live parcel/FEMA layers, keyed by overlay id, with a
//     per-overlay toggle chip and an honest "empty" chip.
//
// MV3 WORKER SEAM: `workerUrl` / `workerClass` are threaded to FloatingMap AND
// installed globally on maplibre-gl before mount (see mapWorker.ts). This is
// what lets the Brief extension consume the library map under Chrome MV3 CSP by
// injecting a vendored, web_accessible CSP-safe worker. Omit for the default
// worker (behavior unchanged).

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { FloatingMap } from '@hauska/map-renderer'
import type { OverlaySpec, ParcelSelection } from '@hauska/map-renderer'
import '@hauska/map-renderer/styles.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { PropertyBriefTile } from '../property-intel/PropertyBriefTile'
import { installMapWorker, type MapWorkerSeam } from './mapWorker'
import {
  MIN_PARCEL_ZOOM,
  LIVE_PARCELS_KEY,
  layersForZoom,
  fetchGisLayer,
  toLiveOverlays,
  selectionToCard,
  createLiveGisGuard,
  type GisLayerResponse,
  type LiveLayerKey,
  type LiveLayerState,
  type LiveOverlaySpec,
  type ParcelCardData,
  type ViewportState,
} from './liveGis'

/**
 * The PUBLISHED @hauska/map-renderer (0.1.1) FloatingMapProps does not yet TYPE
 * two seams the live tile threads:
 *   1. onViewportChange — the viewport (bbox+zoom) emit that drives live GIS
 *      fetching (the renderer's viewport-emit + ViewportState/GisBBox is on
 *      hauska-map main but not in the published dist).
 *   2. workerUrl / workerClass — the MV3 CSP worker seam.
 * We thread both onto the element so that when the renderer publishes the
 * matching props the tile lights up with NO change. Until then: viewport emit
 * is a harmless no-op on the published renderer (the loop simply never fires
 * until the bump), and the effective MV3 mechanism is the global
 * maplibregl.setWorkerUrl install in mapWorker.ts. This augmented element type
 * expresses those pass-throughs without loosening the rest of FloatingMap's
 * props.
 */
const WorkerAwareFloatingMap = FloatingMap as unknown as React.ComponentType<
  React.ComponentProps<typeof FloatingMap> &
    MapWorkerSeam & {
      onViewportChange?: (viewport: ViewportState) => void
    }
>

export interface LiveMapTileProps extends MapWorkerSeam {
  /**
   * Consumer action for the parcel card's "Run property brief" button. Receives
   * the clicked parcel. When omitted the button is hidden (the library tile
   * makes no assumption about the host app's panels or routing).
   */
  onRunBrief?: (parcel: ParcelCardData) => void
  /** Consumer action for the parcel card's "Site analysis" button. */
  onSiteAnalysis?: (parcel: ParcelCardData) => void
}

interface LayerSlot {
  fetch: LiveLayerState
  /** Last good response -- what the overlays render. */
  data: GisLayerResponse | null
}

const IDLE: LayerSlot = { fetch: { status: 'idle' }, data: null }

const chipStyle = (sev: 'info' | 'warn' | 'error'): React.CSSProperties => ({
  fontSize: 10,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  padding: '3px 8px',
  borderRadius: 4,
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  color: sev === 'error' ? '#fca5a5' : sev === 'warn' ? '#fcd34d' : 'var(--h-text-muted, #768390)',
  background: 'rgba(13,17,23,0.78)',
  border: `0.5px solid ${sev === 'error' ? 'rgba(248,113,113,0.6)' : sev === 'warn' ? 'rgba(252,211,77,0.5)' : 'rgba(118,131,144,0.4)'}`,
})

/** Interactive per-overlay toggle chip (report overlay stack). */
const overlayChipStyle = (on: boolean): React.CSSProperties => ({
  fontSize: 10,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  padding: '3px 8px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  color: on ? '#7dd3fc' : 'var(--h-text-muted, #768390)',
  background: 'rgba(13,17,23,0.78)',
  border: `0.5px solid ${on ? 'rgba(125,211,252,0.6)' : 'rgba(118,131,144,0.4)'}`,
})

/** A report overlay as pushed by the tiles: { id, kind, label, geojson, opacity? }. */
interface ReportOverlayView {
  id: string
  kind: string
  label: string
  geojson: unknown
  opacity: number | null
  featureCount: number
}

/** Count drawable features in a GeoJSON payload (FeatureCollection / Feature / bare geometry). */
function featureCountOf(geojson: unknown): number {
  const g = geojson as { type?: string; features?: unknown[] } | null | undefined
  if (!g || typeof g !== 'object' || !g.type) return 0
  if (g.type === 'FeatureCollection') return Array.isArray(g.features) ? g.features.length : 0
  return 1
}

/**
 * Default paints per overlay kind so report geometry reads distinctly over the
 * live layers: contours warm tan, flow lines hydrology blue, zone fills honor
 * the pushed opacity. Paints are STATIC (no animated line-dasharray -- there is
 * a known LineAtlas crash from animating it).
 */
function reportOverlayPaint(kind: string, opacity: number | null): Record<string, unknown> {
  const paint: Record<string, unknown> = {}
  if (kind.includes('contour') || kind.includes('topo')) {
    paint['line-color'] = '#d4a373'
    paint['line-width'] = 1.2
  } else if (kind.includes('flow')) {
    paint['line-color'] = '#38bdf8'
    paint['line-width'] = 2
  }
  if (opacity != null) paint['fill-opacity'] = opacity
  return paint
}

function LiveMapTileInner({ onRunBrief, onSiteAnalysis, workerUrl, workerClass }: LiveMapTileProps) {
  const { activeParcel, setActiveParcel } = useEngagement()
  const { overlays: spatialOverlays } = useSpatial()
  const cortex = useCortexClient()

  // MV3 worker seam: install the consumer's CSP-safe worker URL on maplibre-gl
  // BEFORE FloatingMap's mount effect constructs the Map. Idempotent; a no-op
  // when workerUrl is undefined (default worker, behavior unchanged).
  installMapWorker(workerUrl)

  const [parcels, setParcels] = useState<LayerSlot>(IDLE)
  const [fema, setFema] = useState<LayerSlot>(IDLE)
  const [zoom, setZoom] = useState<number | null>(null)
  const [fixtureOn, setFixtureOn] = useState(false)
  const [card, setCard] = useState<ParcelCardData | null>(null)
  const [hiddenOverlayIds, setHiddenOverlayIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const abortRef = useRef<AbortController | null>(null)
  // Per-layer failure latch (THE STORM GUARD). One instance per tile session:
  // once a layer's bbox query fails hard, its query is skipped on every
  // subsequent viewport emit, so no backend failure can exhaust the browser
  // connection pool. A good response self-heals the latch. See liveGis.ts.
  const guardRef = useRef(createLiveGisGuard())
  // Coalesce: never hold more than one in-flight fetch per layer. A viewport
  // emit that lands while a layer is still fetching supersedes it via the shared
  // AbortController (below); this ref just tracks liveness for the cap.
  const inFlightRef = useRef<Set<LiveLayerKey>>(new Set())

  const { apn, jurisdiction, lat, lng } = activeParcel
  const center = useMemo(
    () => (lat != null && lng != null ? { latitude: lat, longitude: lng } : undefined),
    [lat, lng],
  )
  const flyToParcel = useMemo(
    () => (lat != null && lng != null ? { apn: apn ?? undefined, lat, lng } : null),
    [apn, lat, lng],
  )

  const handleViewportChange = useCallback(
    (vp: ViewportState) => {
      setZoom(vp.zoom)
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const wanted = layersForZoom(vp.zoom)
      const baseUrl = cortex.config.baseUrl

      const guard = guardRef.current
      const inFlight = inFlightRef.current

      const run = (layer: LiveLayerKey, set: React.Dispatch<React.SetStateAction<LayerSlot>>) => {
        if (!wanted.includes(layer)) {
          set({ fetch: { status: 'zoom-gated' }, data: null })
          return
        }
        // STORM GUARD: this layer has already failed hard this session. Do NOT
        // re-issue its bbox query — a repeated 400/502 must never produce more
        // than the few requests it took to trip the latch. Render honest-empty.
        if (guard.isSuppressed(layer)) {
          set((s) => ({ ...s, fetch: guard.suppressedState(layer) }))
          return
        }
        // Concurrency cap: at most one in-flight fetch per layer. The prior
        // controller was already aborted above (abortRef), so a still-listed
        // layer means this emit supersedes it — allow it; the aborted promise
        // resolves to a no-op. This guards against a layer ever holding more
        // than one live socket at a time.
        inFlight.add(layer)
        set((s) => ({ ...s, fetch: { status: 'loading' } }))
        fetchGisLayer(baseUrl, layer, vp.bbox, ctrl.signal)
          .then((state) => {
            if (ctrl.signal.aborted) return
            inFlight.delete(layer)
            // Fold the outcome into the latch: a hard error arms it (no more
            // requests for this layer); an ok/no-coverage clears any prior latch.
            guard.record(layer, state)
            set({ fetch: state, data: state.status === 'ok' ? state.response : null })
          })
          .catch((err) => {
            if (ctrl.signal.aborted || (err as Error)?.name === 'AbortError') return
            inFlight.delete(layer)
            // A thrown fetch (network error surfacing as a reject) is also a hard
            // failure: latch it so viewport churn can't storm the pool.
            const errState: LiveLayerState = {
              status: 'error',
              message: `${layer}: ${(err as Error)?.message}`,
            }
            guard.record(layer, errState)
            set({ fetch: errState, data: null })
          })
      }

      run('parcels', setParcels)
      run('fema', setFema)
    },
    [cortex],
  )

  const handleParcelSelect = useCallback(
    (sel: ParcelSelection) => {
      if (sel.layerKey === LIVE_PARCELS_KEY) {
        const next = selectionToCard(sel)
        setCard(next)
        setActiveParcel({
          apn: next.apn,
          address: next.situsAddress,
          lat: next.lat,
          lng: next.lng,
        })
        return
      }
      // Fixture / zoning click -- legacy behavior: recenter shared context.
      if (sel.lat == null || sel.lng == null) return
      setActiveParcel({
        apn: sel.apn ?? null,
        address: sel.address ?? null,
        lat: sel.lat,
        lng: sel.lng,
      })
    },
    [setActiveParcel],
  )

  // The report overlay stack (SpatialProvider) as pushed by the report tiles.
  const reportOverlays = useMemo<ReportOverlayView[]>(
    () =>
      (spatialOverlays ?? [])
        .filter((o) => o.geojson)
        .map((o) => ({
          id: String(o.id ?? o.kind),
          kind: String(o.kind ?? o.id ?? ''),
          label: o.label || String(o.id ?? o.kind),
          geojson: o.geojson as unknown,
          opacity: o.opacity ?? null,
          featureCount: featureCountOf(o.geojson),
        })),
    [spatialOverlays],
  )

  const toggleOverlay = useCallback((id: string) => {
    setHiddenOverlayIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const mapOverlays = useMemo<LiveOverlaySpec[]>(() => {
    const live = toLiveOverlays(
      parcels.data ? { status: 'ok', response: parcels.data } : parcels.fetch,
      fema.data ? { status: 'ok', response: fema.data } : fema.fetch,
    )
    // Report overlays draw AFTER (= on top of) the live parcel/FEMA layers.
    // layerKey is the overlay id, not kind: drainage and hydrology can both push
    // kind 'hydrology-flow', and keying by kind made one clobber the other.
    // Empty payloads are excluded (honest empty: chip says so, map draws nothing).
    const report: LiveOverlaySpec[] = reportOverlays
      .filter((r) => r.featureCount > 0)
      .map((r) => ({
        layerKey: r.id,
        geojson: r.geojson,
        visible: !hiddenOverlayIds.has(r.id),
        paint: reportOverlayPaint(r.kind, r.opacity),
      }))
    return [...live, ...report]
  }, [parcels, fema, reportOverlays, hiddenOverlayIds])

  // -- honest state chips --------------------------------------------------
  const chips: Array<{ key: string; sev: 'info' | 'warn' | 'error'; text: string }> = []
  if (zoom != null && zoom < MIN_PARCEL_ZOOM) {
    chips.push({ key: 'zoom-hint', sev: 'info', text: 'Zoom in for parcels' })
  }
  if (parcels.fetch.status === 'loading' || fema.fetch.status === 'loading') {
    chips.push({ key: 'loading', sev: 'info', text: 'Loading live layers...' })
  }
  if (parcels.fetch.status === 'ok' && parcels.fetch.response.truncated) {
    chips.push({ key: 'truncated', sev: 'warn', text: 'Parcel set truncated — zoom in for full coverage' })
  }
  if (parcels.fetch.status === 'no-coverage') {
    chips.push({ key: 'parcels-nc', sev: 'warn', text: 'No parcel coverage for this area' })
  }
  if (fema.fetch.status === 'no-coverage') {
    chips.push({ key: 'fema-nc', sev: 'warn', text: 'No FEMA flood coverage for this area' })
  }
  if (parcels.fetch.status === 'error') {
    chips.push({ key: 'parcels-err', sev: 'error', text: `Parcels failed — ${parcels.fetch.message}` })
  }
  if (fema.fetch.status === 'error') {
    chips.push({ key: 'fema-err', sev: 'error', text: `FEMA failed — ${fema.fetch.message}` })
  }
  // Storm guard tripped: the layer is latched off after repeated failure. Say so
  // honestly (the map draws nothing for it, and no further requests are issued).
  if (parcels.fetch.status === 'suppressed') {
    chips.push({ key: 'parcels-sup', sev: 'warn', text: 'Parcels layer paused after repeated errors' })
  }
  if (fema.fetch.status === 'suppressed') {
    chips.push({ key: 'fema-sup', sev: 'warn', text: 'FEMA layer paused after repeated errors' })
  }
  const attribution =
    parcels.fetch.status === 'ok' && parcels.fetch.response.provider
      ? `${parcels.fetch.response.provider}${parcels.fetch.response.notSurveyGrade ? ' · not survey grade' : ''}`
      : null

  const hasParcelContext = lat != null && lng != null

  return (
    <div
      data-testid="live-map-tile"
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

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        <WorkerAwareFloatingMap
          floating={false}
          center={center}
          parcel={flyToParcel}
          address={jurisdiction || undefined}
          useFixture={fixtureOn}
          overlays={mapOverlays}
          onParcelSelect={handleParcelSelect}
          onViewportChange={handleViewportChange}
          workerUrl={workerUrl}
          workerClass={workerClass}
          style={{ flex: 1, minHeight: 0 }}
        />

        {/* Fixture layers must never render unlabeled (tile-level watermark;
            the renderer stamps its own FIXTURE DATA badge on the canvas too). */}
        {fixtureOn && (
          <div
            data-testid="fixture-watermark"
            style={{
              position: 'absolute',
              top: 8,
              right: 48,
              zIndex: 5,
              pointerEvents: 'none',
              padding: '3px 8px',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--font-ui)',
              letterSpacing: '0.12em',
              color: '#b45309',
              background: 'rgba(251,191,36,0.18)',
              border: '1px solid rgba(180,83,9,0.65)',
              borderRadius: 4,
            }}
          >
            FIXTURE
          </div>
        )}

        {/* Honest live-layer state chips. */}
        <div
          data-testid="live-layer-chips"
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 4,
          }}
        >
          {chips.map((c) => (
            <span key={c.key} style={chipStyle(c.sev)}>
              {c.text}
            </span>
          ))}
          {attribution && (
            <span data-testid="live-attribution" style={chipStyle('info')}>
              {attribution}
            </span>
          )}
        </div>

        {/* Report overlay stack: one toggle chip per pushed overlay. Empty
            payloads get an honest non-toggleable "empty" chip -- the map draws
            nothing for them and the chip says so. */}
        {reportOverlays.length > 0 && (
          <div
            data-testid="report-overlay-chips"
            style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              zIndex: 5,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 4,
            }}
          >
            {reportOverlays.map((r) =>
              r.featureCount === 0 ? (
                <span
                  key={r.id}
                  data-testid={`overlay-chip-${r.id}`}
                  style={chipStyle('warn')}
                >
                  {r.label} — empty (nothing to draw)
                </span>
              ) : (
                <button
                  key={r.id}
                  type="button"
                  data-testid={`overlay-chip-${r.id}`}
                  aria-pressed={!hiddenOverlayIds.has(r.id)}
                  onClick={() => toggleOverlay(r.id)}
                  style={overlayChipStyle(!hiddenOverlayIds.has(r.id))}
                >
                  {hiddenOverlayIds.has(r.id) ? '○' : '●'} {r.label} · {r.featureCount}
                </button>
              ),
            )}
          </div>
        )}

        {/* Parcel info card (click-through). */}
        {card && (
          <div
            data-testid="parcel-info-card"
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 6,
              width: 248,
              maxWidth: 'calc(100% - 60px)',
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(13,17,23,0.92)',
              border: '0.5px solid var(--h-border-subtle, #30363d)',
              color: 'var(--h-text-primary, #e6edf3)',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>
                {card.situsAddress || (card.apn ? `APN ${card.apn}` : 'Parcel')}
              </div>
              <button
                type="button"
                aria-label="Close parcel card"
                onClick={() => setCard(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--h-text-muted, #768390)',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
            <dl style={{ margin: '6px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
              {card.apn && (
                <>
                  <dt style={{ color: 'var(--h-text-muted, #768390)' }}>APN</dt>
                  <dd style={{ margin: 0 }} data-testid="parcel-card-apn">{card.apn}</dd>
                </>
              )}
              {card.owner && (
                <>
                  <dt style={{ color: 'var(--h-text-muted, #768390)' }}>Owner</dt>
                  <dd style={{ margin: 0 }}>{card.owner}</dd>
                </>
              )}
              {card.landUseDescription && (
                <>
                  <dt style={{ color: 'var(--h-text-muted, #768390)' }}>Land use</dt>
                  <dd style={{ margin: 0 }}>{card.landUseDescription}</dd>
                </>
              )}
              {card.county && (
                <>
                  <dt style={{ color: 'var(--h-text-muted, #768390)' }}>County</dt>
                  <dd style={{ margin: 0 }}>{card.county}</dd>
                </>
              )}
            </dl>
            {(card.provider || card.notSurveyGrade) && (
              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--h-text-muted, #768390)' }}>
                {card.provider ? `Source: ${card.provider}` : null}
                {card.notSurveyGrade ? `${card.provider ? ' · ' : ''}not survey grade` : null}
              </div>
            )}
            {(onRunBrief || onSiteAnalysis) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {onRunBrief && (
                  <button
                    type="button"
                    onClick={() => onRunBrief(card)}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'var(--font-ui)',
                      color: '#0d1117',
                      background: '#7dd3fc',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Run property brief
                  </button>
                )}
                {onSiteAnalysis && (
                  <button
                    type="button"
                    onClick={() => onSiteAnalysis(card)}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'var(--font-ui)',
                      color: 'var(--h-text-primary, #e6edf3)',
                      background: 'transparent',
                      border: '0.5px solid var(--h-border-subtle, #30363d)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Site analysis
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer: fixture toggle + context readout + in-tile brief card. */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--h-border-subtle, #30363d)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: 'var(--h-space-xs, 4px) var(--h-space-sm, 8px)',
          }}
        >
          <p style={{ fontSize: 10, color: 'var(--h-text-muted, #768390)', margin: 0 }}>
            {hasParcelContext
              ? `Center: ${lat!.toFixed(5)}, ${lng!.toFixed(5)}${apn ? ` · APN ${apn}` : ''}`
              : 'Click a parcel for info, or search an address in the top bar.'}
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontFamily: 'var(--font-ui)',
              color: 'var(--h-text-muted, #768390)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <input
              type="checkbox"
              data-testid="fixture-toggle"
              checked={fixtureOn}
              onChange={(e) => setFixtureOn(e.target.checked)}
              style={{ margin: 0 }}
            />
            Fixture layers
          </label>
        </div>
        {hasParcelContext && <PropertyBriefTile mode="card" />}
      </div>
    </div>
  )
}

export function LiveMapTile(props: LiveMapTileProps = {}) {
  return (
    <TileErrorBoundary label="Map">
      <LiveMapTileInner {...props} />
    </TileErrorBoundary>
  )
}
