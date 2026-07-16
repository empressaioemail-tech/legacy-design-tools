// Tests for the SubsurfaceTile SSURGO map overlay push.
//
// The subsurface REPORT (usdaSsurgoSoilsAdapter point path) carries no
// geometry, so the tile fetches the real SDA WFS map-unit polygons for a
// window around the parcel via /brokerage/v1/map-data/gis-layer and pushes
// them as overlay-kind 'ssurgo-soils'. These tests drive the tile through a
// stubbed global fetch (report run POST -> ok, report GET -> envelope,
// gis-layer POST -> polygon FeatureCollection) and assert the overlay reaches
// the shared spatial stack with the foundation-risk feature properties intact.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SubsurfaceTile, bboxAroundPoint, SSURGO_OVERLAY_KIND } from './SubsurfaceTile'
import { EngagementProvider, SpatialProvider, useSpatial } from '@empressaio/tile-shell'
import { CortexProvider } from '../CortexProvider'
import type { CortexClient } from '@empressaio/cortex-client'

const SOIL_POLYGONS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { mukey: '12345', foundationRiskScore: 4, foundationRiskBand: 'high' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[[-97.75, 30.27], [-97.74, 30.27], [-97.74, 30.28], [-97.75, 30.27]]]],
      },
    },
  ],
}

const client = {
  config: { baseUrl: '/api', getToken: () => '' },
} as unknown as CortexClient

function stubFetch(opts: {
  report?: unknown
  gisStatus?: number
  gisBody?: unknown
}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.endsWith('/reports/subsurface/run')) {
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    if (typeof url === 'string' && url.endsWith('/map-data/gis-layer')) {
      expect(init?.method).toBe('POST')
      return Promise.resolve(
        new Response(JSON.stringify(opts.gisBody ?? {}), {
          status: opts.gisStatus ?? 200,
        }),
      )
    }
    // report GET
    return Promise.resolve(
      new Response(JSON.stringify(opts.report ?? { status: 'ok', result: {} }), {
        status: 200,
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function OverlayProbe() {
  const { overlays } = useSpatial()
  return (
    <div data-testid="overlay-probe">
      {overlays.map((o) => `${o.id}:${o.kind}:${o.geojson?.features.length ?? 0}`).join(',')}
    </div>
  )
}

function renderTile() {
  return render(
    <CortexProvider client={client}>
      <EngagementProvider
        initialParcel={{ engagementId: 'eng-soil', lat: 30.27, lng: -97.74 }}
      >
        <SpatialProvider>
          <SubsurfaceTile />
          <OverlayProbe />
        </SpatialProvider>
      </EngagementProvider>
    </CortexProvider>,
  )
}

describe('bboxAroundPoint', () => {
  it('builds a square window centered on the point', () => {
    const b = bboxAroundPoint(30, -97, 0.01)
    expect(b).toEqual({ west: -97.01, south: 29.99, east: -96.99, north: 30.01 })
  })
})

describe('SubsurfaceTile pushes the SSURGO soils overlay', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes the ssurgo-soils overlay with polygon geometry on a healthy run', async () => {
    stubFetch({
      report: { status: 'ok', result: { kind: 'ssurgo-soils', foundationRiskScore: 4 } },
      gisBody: { layer: 'ssurgo-soils', geojson: SOIL_POLYGONS, featureCount: 1 },
    })

    renderTile()
    fireEvent.click(screen.getByTestId('subsurface-run'))

    await waitFor(() =>
      expect(screen.getByTestId('overlay-probe').textContent).toContain(SSURGO_OVERLAY_KIND),
    )
    // Overlay id + kind + real feature count reached the shared spatial stack.
    expect(screen.getByTestId('overlay-probe').textContent).toContain('subsurface-ssurgo:ssurgo-soils:1')
    await screen.findByText(/pushed to Map overlay stack/)
  })

  it('pushes NO overlay and notes no-coverage on a 404 gis-layer', async () => {
    stubFetch({
      report: { status: 'ok', result: { kind: 'ssurgo-soils' } },
      gisStatus: 404,
      gisBody: { message: 'No SSURGO map-unit polygons in this viewport.' },
    })

    renderTile()
    fireEvent.click(screen.getByTestId('subsurface-run'))

    await screen.findByText(/No SSURGO map-unit polygons/)
    expect(screen.getByTestId('overlay-probe').textContent).toBe('')
  })

  it('pushes NO overlay when the parcel is not geocoded', async () => {
    stubFetch({ report: { status: 'ok', result: { kind: 'ssurgo-soils' } } })
    render(
      <CortexProvider client={client}>
        <EngagementProvider initialParcel={{ engagementId: 'eng-no-geo' }}>
          <SpatialProvider>
            <SubsurfaceTile />
            <OverlayProbe />
          </SpatialProvider>
        </EngagementProvider>
      </CortexProvider>,
    )
    fireEvent.click(screen.getByTestId('subsurface-run'))

    await screen.findByText(/not geocoded/)
    expect(screen.getByTestId('overlay-probe').textContent).toBe('')
  })
})
