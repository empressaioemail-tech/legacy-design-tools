// Regression tests for the Hydrology tile capability banner.
//
// Shipped 0.1.3 hardcoded a "Degraded: pysheds not installed in Cloud Run
// worker." banner unconditionally — the console kept showing it after the
// backend was fixed (drainage/hydrology runs return library:pysheds, live).
// The banner must be driven by the RUN RESULT (hydrologyDegraded/-Reason),
// never asserted statically.
//
// 0.1.6: the tile now calls the pure fetchHydrology(baseUrl, ...) function
// internally (single source of truth). The test drives it through a stubbed
// global fetch (run POST -> ok, get GET -> report envelope) with a real
// CortexClient config, proving the same banner behavior over the new path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HydrologyTile } from './HydrologyTile'
import { EngagementProvider, SpatialProvider, useSpatial } from '@empressaio/tile-shell'
import { CortexProvider } from '../CortexProvider'
import type { CortexClient } from '@empressaio/cortex-client'

const FLOW_LINES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-97.32, 30.11],
          [-97.31, 30.12],
        ],
      },
    },
  ],
}

// A CortexClient with only the config the pure function reads (baseUrl +
// getToken). No runReport/getReport methods are used anymore — the tile calls
// the pure fetchHydrology(baseUrl, ...) function, which uses global fetch.
const client = {
  config: { baseUrl: '/api/spine/cortex/api', getToken: () => '' },
} as unknown as CortexClient

/**
 * Stub global fetch so the run POST resolves ok and the report GET returns the
 * given ReportResult envelope. Returns the fetch mock for URL assertions.
 */
function stubReportFetch(envelope: unknown) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.endsWith('/reports/hydrology/run')) {
      expect(init?.method).toBe('POST')
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    return Promise.resolve(
      new Response(JSON.stringify(envelope), { status: 200 }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function OverlayProbe() {
  const { overlays } = useSpatial()
  return <div data-testid="overlay-probe">{overlays.map((o) => o.id).join(',')}</div>
}

function renderTile() {
  return render(
    <CortexProvider client={client}>
      <EngagementProvider initialParcel={{ engagementId: 'eng-hydro' }}>
        <SpatialProvider>
          <HydrologyTile />
          <OverlayProbe />
        </SpatialProvider>
      </EngagementProvider>
    </CortexProvider>,
  )
}

describe('HydrologyTile banner reflects the live run result (via pure fetchHydrology)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows NO degraded banner (and pushes flow lines) when the run is healthy', async () => {
    stubReportFetch({
      status: 'ok',
      result: {
        flowLinesGeoJson: FLOW_LINES,
        hydrologyLibrary: 'pysheds',
        hydrologyDegraded: false,
        hydrologyDegradedReason: null,
      },
    })

    renderTile()

    // Before the run: live banner (null render), no static degraded claim.
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()

    fireEvent.click(screen.getByTestId('hydrology-run'))

    await waitFor(() => expect(screen.getByText('Engine: pysheds')).toBeTruthy())
    // THE regression: no hardcoded degraded banner on a healthy run.
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
    expect(screen.queryByText(/pysheds not installed/)).toBeNull()
    // Overlay reached the shared spatial stack.
    expect(screen.getByTestId('overlay-probe').textContent).toContain('hydrology-flow')
  })

  it('shows the run-reported reason when the run IS degraded', async () => {
    stubReportFetch({
      status: 'ok',
      result: {
        flowLinesGeoJson: FLOW_LINES,
        hydrologyLibrary: 'native-d8',
        hydrologyDegraded: true,
        hydrologyDegradedReason: 'pysheds unavailable; native D8 fallback',
      },
    })

    renderTile()
    fireEvent.click(screen.getByTestId('hydrology-run'))

    const banner = await screen.findByTestId('tile-status-banner')
    expect(banner.textContent).toContain('Degraded')
    expect(banner.textContent).toContain('pysheds unavailable; native D8 fallback')
  })

  it('surfaces a run error honestly instead of a stale banner', async () => {
    stubReportFetch({
      status: 'error',
      error: 'DEM fetch failed upstream',
    })

    renderTile()
    fireEvent.click(screen.getByTestId('hydrology-run'))

    await waitFor(() => expect(screen.getByText('DEM fetch failed upstream')).toBeTruthy())
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
  })
})
