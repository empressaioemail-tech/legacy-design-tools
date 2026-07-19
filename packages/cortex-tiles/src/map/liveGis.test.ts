// packages/cortex-tiles/src/map/liveGis.test.ts
//
// Unit tests for the promoted live-GIS Map tile logic: viewport fetch policy,
// the gis-layer client's honest state mapping (404 -> no-coverage, failures ->
// named errors, never a fixture fallback), overlay composition/order, and the
// parcel-selection -> info-card payload. Ported from apps/command-center into
// the library alongside the tile.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  MIN_PARCEL_ZOOM,
  MIN_FEMA_ZOOM,
  LIVE_PARCELS_KEY,
  LIVE_FEMA_KEY,
  layersForZoom,
  coarseAffordanceForZoom,
  fetchGisLayer,
  parcelFillColor,
  toLiveOverlays,
  selectionToCard,
  normalizeBbox,
  createLiveGisGuard,
  shouldSuppressAfter,
  buildableEnvelopeOverlay,
  buildableEnvelopePaint,
  buildableEnvelopeCard,
  BUILDABLE_ENVELOPE_KEY,
  type FeatureCollectionLike,
  type LiveLayerState,
  type BuildableEnvelopePayload,
} from './liveGis'

const SAN_MARCOS_BBOX = { west: -97.934, south: 29.865, east: -97.92, north: 29.876 }

function fc(properties: Array<Record<string, unknown>>): FeatureCollectionLike {
  return {
    type: 'FeatureCollection',
    features: properties.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      properties: p,
    })),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layersForZoom (viewport fetch policy)', () => {
  it('still allows coarse context layers at wide zooms (never a blank map)', () => {
    // Below the parcel floor the map is NOT empty: the coarse context layers
    // that are cheaply fetchable wide-out (edwards aquifer to 10, fema to 11,
    // districts) keep something real on screen. This is the zoom-out fix.
    const wide = layersForZoom(MIN_FEMA_ZOOM - 1) // zoom 10
    expect(wide).toContain('edwards-aquifer')
    expect(wide).not.toContain('parcels')
  })
  it('gates parcels below the parcel floor but keeps fema + federal context', () => {
    const mid = layersForZoom(MIN_PARCEL_ZOOM - 1) // zoom 13
    expect(mid).toContain('fema')
    expect(mid).toContain('ssurgo-soils')
    expect(mid).not.toContain('parcels')
  })
  it('fetches parcels + the full layer set at parcel zoom', () => {
    const full = layersForZoom(MIN_PARCEL_ZOOM)
    expect(full).toContain('parcels')
    expect(full).toContain('fema')
    expect(full).toContain('groundwater')
    expect(full).toContain('texas-rrc')
    expect(layersForZoom(15.2)).toContain('parcels')
  })
})

describe('coarseAffordanceForZoom (LOD honest-empty)', () => {
  it('reports coarse + an honest note below the parcel floor', () => {
    const a = coarseAffordanceForZoom(MIN_PARCEL_ZOOM - 1)
    expect(a.coarse).toBe(true)
    expect(a.note).toMatch(/zoom in/i)
    expect(a.availableLayers).not.toContain('parcels')
  })
  it('is non-coarse (full detail) at/above the parcel floor', () => {
    const a = coarseAffordanceForZoom(MIN_PARCEL_ZOOM)
    expect(a.coarse).toBe(false)
    expect(a.note).toBe('')
    expect(a.availableLayers).toContain('parcels')
  })
})

describe('federal layer overlays (real layers, distinct paints)', () => {
  it('composes a distinct overlay per federal layer from a state map', () => {
    const soils: LiveLayerState = {
      status: 'ok',
      response: {
        layer: 'ssurgo-soils',
        provider: 'USDA',
        geojson: fc([{ foundationRiskBand: 'high' }]),
      },
    }
    const gw: LiveLayerState = {
      status: 'ok',
      response: {
        layer: 'groundwater',
        provider: 'USGS',
        geojson: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
          ],
        },
      },
    }
    const specs = toLiveOverlays({ 'ssurgo-soils': soils, groundwater: gw })
    const keys = specs.map((s) => s.layerKey)
    expect(keys).toContain('live-ssurgo')
    expect(keys).toContain('live-groundwater')
    // groundwater is a point layer — carries circle paint, not fill.
    const gwSpec = specs.find((s) => s.layerKey === 'live-groundwater')
    expect(gwSpec?.paint?.['circle-color']).toBeDefined()
  })
})

describe('fetchGisLayer (bbox -> proxy POST -> honest states)', () => {
  it('POSTs the bbox to the gis-layer path and returns ok with the envelope', async () => {
    const envelope = {
      layer: 'parcels',
      provider: 'Hays County parcels (TxGIO/StratMap)',
      featureCount: 2,
      truncated: false,
      notSurveyGrade: true,
      geojson: fc([{ apn: '12311' }, { apn: '12312' }]),
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const state = await fetchGisLayer('/api/spine/cortex/api', 'parcels', SAN_MARCOS_BBOX)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/spine/cortex/api/brokerage/v1/map-data/gis-layer')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ layer: 'parcels', bbox: SAN_MARCOS_BBOX })

    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.response.provider).toBe('Hays County parcels (TxGIO/StratMap)')
      expect(state.response.geojson?.features).toHaveLength(2)
    }
  })

  it('uses an INJECTED fetch (MV3 worker-proxy) and works with a brokerage baseUrl', async () => {
    const envelope = { layer: 'parcels', featureCount: 1, geojson: fc([{ apn: '9' }]) }
    const injected = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 200 }))
    const globalFetch = vi.fn().mockRejectedValue(new Error('global fetch must not be used'))
    vi.stubGlobal('fetch', globalFetch)

    // Brokerage-shaped baseUrl (origin/proxy root); fetchGisLayer appends
    // /brokerage/v1/map-data/gis-layer.
    const state = await fetchGisLayer('https://cortex.example/api', 'parcels', SAN_MARCOS_BBOX, {
      fetch: injected,
    })

    expect(injected).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
    expect(injected.mock.calls[0][0]).toBe(
      'https://cortex.example/api/brokerage/v1/map-data/gis-layer',
    )
    expect(state.status).toBe('ok')
  })

  it('still accepts a bare AbortSignal as the 4th arg (back-compat)', async () => {
    const injected = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ layer: 'parcels', geojson: fc([]) }), { status: 200 }),
    )
    vi.stubGlobal('fetch', injected)
    const ac = new AbortController()
    await fetchGisLayer('/api/spine/cortex/api', 'parcels', SAN_MARCOS_BBOX, ac.signal)
    expect(injected.mock.calls[0][1]?.signal).toBe(ac.signal)
  })

  it('maps 404 to an honest no-coverage state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not-found', message: 'no adapter for county' }), {
          status: 404,
        }),
      ),
    )
    const state = await fetchGisLayer('/api/spine/cortex/api', 'parcels', SAN_MARCOS_BBOX)
    expect(state).toEqual({ status: 'no-coverage', detail: 'no adapter for county' })
  })

  it('maps upstream failures to a NAMED error state (no silent fixture fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'upstream-error', message: 'Cotality OAuth token responded HTTP 500' }),
          { status: 502 },
        ),
      ),
    )
    const state = await fetchGisLayer('/api/spine/cortex/api', 'parcels', SAN_MARCOS_BBOX)
    expect(state.status).toBe('error')
    if (state.status === 'error') {
      expect(state.message).toContain('parcels')
      expect(state.message).toContain('Cotality OAuth token responded HTTP 500')
    }
  })

  it('maps network failure to a named error carrying the layer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const state = await fetchGisLayer('/api/spine/cortex/api', 'fema', SAN_MARCOS_BBOX)
    expect(state).toEqual({ status: 'error', message: 'fema: Failed to fetch' })
  })

  it('sends a STRICT-CLEAN body: exactly {layer, bbox:{west,south,east,north}} — strips any extra viewport key (the 400 fix)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ layer: 'parcels', geojson: fc([]) }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    // A viewport carrier that (like the renderer / old client) drags along extra
    // keys the server's .strict() body rejects: zoom, and stray corner aliases.
    const dirtyBbox = {
      west: -97.934,
      south: 29.865,
      east: -97.92,
      north: 29.876,
      zoom: 15.2,
      westLng: -97.934,
    } as unknown as typeof SAN_MARCOS_BBOX
    await fetchGisLayer('/api/spine/cortex/api', 'parcels', dirtyBbox)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    // Exactly two top-level keys, and bbox has exactly the four cardinal keys.
    expect(Object.keys(body).sort()).toEqual(['bbox', 'layer'])
    expect(Object.keys(body.bbox).sort()).toEqual(['east', 'north', 'south', 'west'])
    expect(body.bbox).toEqual({ west: -97.934, south: 29.865, east: -97.92, north: 29.876 })
    expect(body.bbox).not.toHaveProperty('zoom')
    expect(body.bbox).not.toHaveProperty('westLng')
  })
})

describe('normalizeBbox (strict-clean picker)', () => {
  it('picks exactly the four cardinal keys and drops everything else', () => {
    const out = normalizeBbox({
      west: -1,
      south: -2,
      east: 3,
      north: 4,
      // extras a viewport object may carry
      zoom: 15,
      pitch: 0,
    } as unknown as Parameters<typeof normalizeBbox>[0])
    expect(out).toEqual({ west: -1, south: -2, east: 3, north: 4 })
    expect(Object.keys(out).sort()).toEqual(['east', 'north', 'south', 'west'])
  })
})

describe('createLiveGisGuard (per-layer failure latch — the storm guard)', () => {
  it('suppresses a layer after a hard error and self-heals on a later ok', () => {
    const guard = createLiveGisGuard()
    expect(guard.isSuppressed('fema')).toBe(false)

    guard.record('fema', { status: 'error', message: 'fema: HTTP 502' })
    expect(guard.isSuppressed('fema')).toBe(true)
    expect(guard.suppressedState('fema')).toEqual({ status: 'suppressed', message: 'fema: HTTP 502' })
    // a different layer is unaffected
    expect(guard.isSuppressed('parcels')).toBe(false)

    // an ok response clears the latch
    guard.record('fema', { status: 'ok', response: { layer: 'fema' } })
    expect(guard.isSuppressed('fema')).toBe(false)
  })

  it('does NOT suppress on 404 no-coverage (honest empty, legitimately varies by viewport)', () => {
    const guard = createLiveGisGuard()
    guard.record('parcels', { status: 'no-coverage' })
    expect(guard.isSuppressed('parcels')).toBe(false)
    expect(shouldSuppressAfter({ status: 'no-coverage' })).toBe(false)
    expect(shouldSuppressAfter({ status: 'error', message: 'x' })).toBe(true)
  })

  it('reset() clears all latches', () => {
    const guard = createLiveGisGuard()
    guard.record('fema', { status: 'error', message: 'e' })
    guard.record('parcels', { status: 'error', message: 'e' })
    guard.reset()
    expect(guard.isSuppressed('fema')).toBe(false)
    expect(guard.isSuppressed('parcels')).toBe(false)
  })
})

describe('parcelFillColor (color by landUseCode where present, neutral otherwise)', () => {
  it('returns a neutral constant when no landUseCode is present (e.g. Hays TxGIO)', () => {
    const color = parcelFillColor(fc([{ apn: '1' }, { apn: '2' }]))
    expect(typeof color).toBe('string')
  })
  it('returns a categorical match expression over the codes present', () => {
    const color = parcelFillColor(fc([{ landUseCode: 'COM' }, { landUseCode: 'MF' }])) as unknown[]
    expect(Array.isArray(color)).toBe(true)
    expect(color[0]).toBe('match')
    expect(color).toContain('COM')
    expect(color).toContain('MF')
  })
})

describe('toLiveOverlays (overlay composition)', () => {
  const okParcels: LiveLayerState = {
    status: 'ok',
    response: { layer: 'parcels', provider: 'p', geojson: fc([{ apn: '1' }]) },
  }
  const okFema: LiveLayerState = {
    status: 'ok',
    response: { layer: 'fema', provider: 'FEMA NFHL', geojson: fc([{ FLD_ZONE: 'AO' }]) },
  }

  it('orders FEMA below parcels and marks only parcels interactive', () => {
    const specs = toLiveOverlays(okParcels, okFema)
    expect(specs.map((s) => s.layerKey)).toEqual([LIVE_FEMA_KEY, LIVE_PARCELS_KEY])
    expect(specs[0].interactive).toBeUndefined()
    expect(specs[1].interactive).toBe(true)
  })

  it('renders nothing for error / no-coverage / zoom-gated / suppressed states (honest empty, not fixtures)', () => {
    expect(toLiveOverlays({ status: 'error', message: 'x' }, { status: 'no-coverage' })).toEqual([])
    expect(toLiveOverlays({ status: 'zoom-gated' }, { status: 'idle' })).toEqual([])
    expect(
      toLiveOverlays({ status: 'suppressed', message: 'p' }, { status: 'suppressed', message: 'f' }),
    ).toEqual([])
  })
})

describe('selectionToCard (click payload)', () => {
  it('extracts the info-card fields from a live-parcel selection', () => {
    const card = selectionToCard({
      layerKey: LIVE_PARCELS_KEY,
      lat: 29.87019,
      lng: -97.92754,
      properties: {
        parcel_node_id: '48209:R12311',
        apn: '12311',
        situsAddress: '600 CAPE RD, SAN MARCOS, TX 78666',
        owner: 'TEXAS PARKS & WILDLIFE DEPT',
        countyName: 'Hays',
        countyFips: '48209',
        provider: 'txgio',
        notSurveyGrade: true,
        retrievedAt: '2026-07-14T11:22:11.251Z',
      },
    })
    expect(card).toEqual({
      parcelNodeId: '48209:R12311',
      apn: '12311',
      situsAddress: '600 CAPE RD, SAN MARCOS, TX 78666',
      owner: 'TEXAS PARKS & WILDLIFE DEPT',
      landUseDescription: null,
      county: 'Hays County (48209)',
      provider: 'txgio',
      notSurveyGrade: true,
      retrievedAt: '2026-07-14T11:22:11.251Z',
      lat: 29.87019,
      lng: -97.92754,
    })
  })

  it('carries the canonical parcel_node_id onto the card when present', () => {
    // The seam this change closes: the backend stamps parcel_node_id on the
    // feature; the selection must surface it so the frontend feature-state
    // highlight can key on the canonical id instead of the apn fallback.
    const card = selectionToCard({
      layerKey: LIVE_PARCELS_KEY,
      properties: { parcel_node_id: '48453:R000123', apn: '000123' },
    })
    expect(card.parcelNodeId).toBe('48453:R000123')
    expect(card.apn).toBe('000123')
  })

  it('falls back cleanly when parcel_node_id is absent (apn still resolves, no crash)', () => {
    // Back-compat: a feature that predates the canonical id has no
    // parcel_node_id; the card must still resolve on apn with parcelNodeId null.
    const card = selectionToCard({ properties: { apn: '000123' } })
    expect(card.parcelNodeId).toBeNull()
    expect(card.apn).toBe('000123')
  })

  it('prefers landUseDescription and falls back to landUseCode', () => {
    expect(
      selectionToCard({ properties: { landUseDescription: 'Commercial', landUseCode: 'COM' } })
        .landUseDescription,
    ).toBe('Commercial')
    expect(selectionToCard({ properties: { landUseCode: 'COM' } }).landUseDescription).toBe('COM')
  })
})

describe('buildableEnvelope report overlay (derived, confidence-aware paint)', () => {
  function envPayload(
    approximate: boolean,
    withGeometry = true,
  ): BuildableEnvelopePayload {
    return {
      approximate,
      empty: !withGeometry,
      citationUrl: 'https://library.municode.com/tx/bastrop',
      district: 'R-MD Residential Medium Density',
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: withGeometry
              ? { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
              : (null as unknown as FeatureCollectionLike['features'][number]['geometry']),
            properties: {
              approximate,
              notSurveyGrade: true,
              disclosure: approximate ? 'Approximate — verify with survey.' : 'Not survey grade.',
              citationUrl: 'https://library.municode.com/tx/bastrop',
              buildableAreaSqFt: 13175,
              buildableAreaPct: 65.9,
              maxFootprintSqFt: 8000,
              maxHeightFt: 35,
              edgeSignal: approximate ? 'shape' : 'road',
              setbacks: { front_ft: 25, side_ft: 7.5, rear_ft: 20, district: 'R-MD' },
            },
          },
        ],
      },
    }
  }

  it('draws a green solid overlay when high-confidence', () => {
    const spec = buildableEnvelopeOverlay(envPayload(false))!
    expect(spec.layerKey).toBe(BUILDABLE_ENVELOPE_KEY)
    expect(spec.paint!['line-color']).toBe('#15803d')
    expect(spec.paint!['line-dasharray']).toBeUndefined()
  })

  it('draws an amber dashed overlay when approximate', () => {
    const spec = buildableEnvelopeOverlay(envPayload(true))!
    expect(spec.paint!['line-color']).toBe('#b45309')
    expect(spec.paint!['line-dasharray']).toEqual([2, 2])
  })

  it('returns null for an empty (no-buildable-area) envelope', () => {
    expect(buildableEnvelopeOverlay(envPayload(false, false))).toBeNull()
    expect(buildableEnvelopeOverlay(null)).toBeNull()
    expect(buildableEnvelopeOverlay({ geojson: undefined })).toBeNull()
  })

  it('paint is dashed+amber for approximate, solid+green otherwise', () => {
    expect(buildableEnvelopePaint(true)['line-dasharray']).toEqual([2, 2])
    expect(buildableEnvelopePaint(false)['line-dasharray']).toBeUndefined()
  })

  it('extracts a card with disclosure + citation + sizing', () => {
    const card = buildableEnvelopeCard(envPayload(true))!
    expect(card.approximate).toBe(true)
    expect(card.disclosure).toMatch(/verify/i)
    expect(card.citationUrl).toMatch(/municode/i)
    expect(card.buildableAreaSqFt).toBe(13175)
    expect(card.maxFootprintSqFt).toBe(8000)
    expect(card.maxHeightFt).toBe(35)
    expect(card.edgeSignal).toBe('shape')
  })
})
