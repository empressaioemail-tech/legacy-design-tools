// packages/cortex-tiles/src/map/LiveMapTile.test.tsx
//
// Component tests for the PROMOTED library live Map tile. These prove the two
// things the promotion is about:
//   1. The tile drives the LIVE GIS path — on a viewport change it POSTs the
//      bbox to the cortex proxy (baseUrl from useCortexClient) for parcels+fema
//      and passes the results to the map as overlays; it never falls back to a
//      silent fixture on error. (The published fixture-only MapTile does none of
//      this — that is the regression this promotion fixes.)
//   2. The MV3 worker seam is threaded: a consumer-provided workerUrl is (a)
//      installed on maplibre-gl via setWorkerUrl before mount, and (b) forwarded
//      as a prop to FloatingMap so the renderer-level seam lights up on the
//      @hauska/map-renderer bump with no tile change.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { EngagementProvider, SpatialProvider } from '@empressaio/tile-shell'
import type { CortexClient } from '@empressaio/cortex-client'
import { CortexProvider } from '../CortexProvider'
import { LIVE_PARCELS_KEY, LIVE_FEMA_KEY } from './liveGis'
import { __resetInstalledMapWorker } from './mapWorker'

// -- mocks ----------------------------------------------------------------
const { floatingMapProps } = vi.hoisted(() => ({
  floatingMapProps: [] as Array<Record<string, any>>,
}))

vi.mock('@hauska/map-renderer', () => ({
  FloatingMap: (props: Record<string, any>) => {
    floatingMapProps.push(props)
    return <div data-testid="floating-map-stub" data-usefixture={String(props.useFixture)} />
  },
}))
vi.mock('@hauska/map-renderer/styles.css', () => ({}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

// Capture the maplibre setWorkerUrl calls (the effective MV3 worker install).
const { setWorkerUrlMock } = vi.hoisted(() => ({ setWorkerUrlMock: vi.fn() }))
vi.mock('maplibre-gl', () => ({
  default: { setWorkerUrl: setWorkerUrlMock },
  setWorkerUrl: setWorkerUrlMock,
}))

// PropertyBriefTile hits the cortex client on parcel context; stub it so these
// tests stay focused on the map/loader/seam behavior.
vi.mock('../property-intel/PropertyBriefTile', () => ({
  PropertyBriefTile: () => <div data-testid="brief-card-stub" />,
}))

import { LiveMapTile } from './LiveMapTile'

const latestMapProps = () => floatingMapProps[floatingMapProps.length - 1]

const BASE_URL = '/api/spine/cortex/api'

/** A minimal CortexClient carrying just the baseUrl the loader reads. */
function makeClient(): CortexClient {
  return { config: { baseUrl: BASE_URL, getToken: () => '' } } as unknown as CortexClient
}

const SAN_MARCOS_VIEWPORT = {
  bbox: { west: -97.934, south: 29.865, east: -97.92, north: 29.876 },
  zoom: 15.2,
}

const PARCELS_ENVELOPE = {
  layer: 'parcels',
  provider: 'Hays County parcels (TxGIO/StratMap)',
  featureCount: 1,
  truncated: false,
  notSurveyGrade: true,
  geojson: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
        properties: { apn: '12311', situsAddress: '600 CAPE RD, SAN MARCOS, TX 78666' },
      },
    ],
  },
}

const FEMA_ENVELOPE = {
  layer: 'fema',
  provider: 'FEMA NFHL',
  featureCount: 1,
  truncated: false,
  geojson: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
        properties: { FLD_ZONE: 'AO' },
      },
    ],
  },
}

function mockFetchByLayer(handlers: Record<string, () => Response | Promise<Response>>) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const { layer } = JSON.parse(String(init?.body ?? '{}'))
    const handler = handlers[layer]
    if (!handler) throw new Error(`unexpected layer ${layer}`)
    return handler()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderTile(props: React.ComponentProps<typeof LiveMapTile> = {}) {
  return render(
    <CortexProvider client={makeClient()}>
      <EngagementProvider>
        <SpatialProvider>
          <LiveMapTile {...props} />
        </SpatialProvider>
      </EngagementProvider>
    </CortexProvider>,
  )
}

beforeEach(() => {
  floatingMapProps.length = 0
  setWorkerUrlMock.mockClear()
  __resetInstalledMapWorker()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live GIS path (the promotion)', () => {
  it('fetches parcels + fema for the viewport bbox (baseUrl from the client) and passes them to the map as overlays', async () => {
    const fetchMock = mockFetchByLayer({
      parcels: () => new Response(JSON.stringify(PARCELS_ENVELOPE), { status: 200 }),
      fema: () => new Response(JSON.stringify(FEMA_ENVELOPE), { status: 200 }),
    })
    renderTile()

    act(() => latestMapProps().onViewportChange(SAN_MARCOS_VIEWPORT))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)))
    expect(bodies).toEqual(
      expect.arrayContaining([
        { layer: 'parcels', bbox: SAN_MARCOS_VIEWPORT.bbox },
        { layer: 'fema', bbox: SAN_MARCOS_VIEWPORT.bbox },
      ]),
    )
    // Base URL comes from the injected CortexClient, not a command-center local.
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe(`${BASE_URL}/brokerage/v1/map-data/gis-layer`)
    }

    await waitFor(() => {
      const overlays = latestMapProps().overlays
      expect(overlays.map((o: any) => o.layerKey)).toEqual([LIVE_FEMA_KEY, LIVE_PARCELS_KEY])
      expect(overlays[1].geojson.features[0].properties.apn).toBe('12311')
      expect(overlays[1].interactive).toBe(true)
    })
    expect(screen.getByTestId('live-attribution').textContent).toContain(
      'Hays County parcels (TxGIO/StratMap)',
    )
  })

  it('shows an honest empty state on 404 and a NAMED error on failure — no fixture fallback', async () => {
    mockFetchByLayer({
      parcels: () =>
        new Response(JSON.stringify({ error: 'not-found', message: 'no coverage' }), {
          status: 404,
        }),
      fema: () =>
        new Response(JSON.stringify({ error: 'upstream-error', message: 'NFHL unavailable' }), {
          status: 502,
        }),
    })
    renderTile()
    act(() => latestMapProps().onViewportChange(SAN_MARCOS_VIEWPORT))

    await waitFor(() => {
      expect(screen.getByText('No parcel coverage for this area')).toBeTruthy()
      expect(screen.getByText(/FEMA failed — fema: NFHL unavailable/)).toBeTruthy()
    })
    // No live overlays AND no fixture fallback: the map stays honest-empty.
    expect(latestMapProps().overlays).toEqual([])
    expect(latestMapProps().useFixture).toBe(false)
  })

  it('gates parcels at wide zooms with a zoom-in hint instead of fetching', async () => {
    const fetchMock = mockFetchByLayer({
      fema: () => new Response(JSON.stringify(FEMA_ENVELOPE), { status: 200 }),
    })
    renderTile()
    act(() => latestMapProps().onViewportChange({ bbox: SAN_MARCOS_VIEWPORT.bbox, zoom: 12 }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).layer).toBe('fema')
    expect(screen.getByText('Zoom in for parcels')).toBeTruthy()
  })
})

describe('MV3 worker seam', () => {
  it('installs a consumer workerUrl on maplibre-gl AND forwards it to FloatingMap', () => {
    mockFetchByLayer({})
    const WORKER_URL = 'chrome-extension://abc/maplibre-gl-csp-worker.js'
    renderTile({ workerUrl: WORKER_URL })

    // (a) effective install: maplibre-gl.setWorkerUrl called with the URL.
    expect(setWorkerUrlMock).toHaveBeenCalledWith(WORKER_URL)
    // (b) threaded through: FloatingMap receives the same workerUrl prop, so the
    //     renderer-level seam lights up on the @hauska/map-renderer bump.
    expect(latestMapProps().workerUrl).toBe(WORKER_URL)
  })

  it('leaves the default worker in place when no workerUrl is provided (behavior unchanged)', () => {
    mockFetchByLayer({})
    renderTile()
    expect(setWorkerUrlMock).not.toHaveBeenCalled()
    expect(latestMapProps().workerUrl).toBeUndefined()
  })
})

describe('parcel click-through + injectable actions', () => {
  const SELECTION = {
    layerKey: LIVE_PARCELS_KEY,
    lat: 29.87019,
    lng: -97.92754,
    apn: '12311',
    address: '600 CAPE RD, SAN MARCOS, TX 78666',
    properties: {
      layerKey: LIVE_PARCELS_KEY,
      apn: '12311',
      situsAddress: '600 CAPE RD, SAN MARCOS, TX 78666',
      owner: 'TEXAS PARKS & WILDLIFE DEPT',
      countyName: 'Hays',
      countyFips: '48209',
      provider: 'txgio',
      notSurveyGrade: true,
    },
  }

  it('opens the info card with the parcel identity and attribution', async () => {
    mockFetchByLayer({})
    renderTile()
    act(() => latestMapProps().onParcelSelect(SELECTION))

    const card = await screen.findByTestId('parcel-info-card')
    expect(card.textContent).toContain('600 CAPE RD, SAN MARCOS, TX 78666')
    expect(screen.getByTestId('parcel-card-apn').textContent).toContain('12311')
    expect(card.textContent).toContain('TEXAS PARKS & WILDLIFE DEPT')
    expect(card.textContent).toContain('Hays County (48209)')
    expect(card.textContent).toContain('Source: txgio')
  })

  it('invokes injected onRunBrief / onSiteAnalysis with the parcel; hides the buttons when not provided', async () => {
    mockFetchByLayer({})
    const onRunBrief = vi.fn()
    const onSiteAnalysis = vi.fn()
    renderTile({ onRunBrief, onSiteAnalysis })
    act(() => latestMapProps().onParcelSelect(SELECTION))

    fireEvent.click(await screen.findByText('Run property brief'))
    expect(onRunBrief).toHaveBeenCalledWith(expect.objectContaining({ apn: '12311' }))
    fireEvent.click(screen.getByText('Site analysis'))
    expect(onSiteAnalysis).toHaveBeenCalledWith(expect.objectContaining({ apn: '12311' }))
  })

  it('renders no action buttons when the consumer injects no actions (no dead buttons)', async () => {
    mockFetchByLayer({})
    renderTile()
    act(() => latestMapProps().onParcelSelect(SELECTION))
    await screen.findByTestId('parcel-info-card')
    expect(screen.queryByText('Run property brief')).toBeNull()
    expect(screen.queryByText('Site analysis')).toBeNull()
  })
})

describe('fixture labeling rule', () => {
  it('defaults fixture layers OFF and labels them FIXTURE when toggled on', async () => {
    mockFetchByLayer({})
    renderTile()

    expect(latestMapProps().useFixture).toBe(false)
    expect(screen.queryByTestId('fixture-watermark')).toBeNull()

    fireEvent.click(screen.getByTestId('fixture-toggle'))
    await waitFor(() => expect(latestMapProps().useFixture).toBe(true))
    expect(screen.getByTestId('fixture-watermark').textContent).toBe('FIXTURE')
  })
})
