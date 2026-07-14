// Regression tests for the Hydrology tile capability banner.
//
// Shipped 0.1.3 hardcoded a "Degraded: pysheds not installed in Cloud Run
// worker." banner unconditionally — the console kept showing it after the
// backend was fixed (drainage/hydrology runs return library:pysheds, live).
// The banner must be driven by the RUN RESULT (hydrologyDegraded/-Reason),
// never asserted statically.

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

function OverlayProbe() {
  const { overlays } = useSpatial()
  return <div data-testid="overlay-probe">{overlays.map((o) => o.id).join(',')}</div>
}

function renderTile(client: CortexClient) {
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

describe('HydrologyTile banner reflects the live run result', () => {
  let client: CortexClient
  let getReportSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getReportSpy = vi.fn()
    client = {
      runReport: vi.fn().mockResolvedValue({}),
      getReport: getReportSpy,
    } as unknown as CortexClient
  })

  it('shows NO degraded banner (and pushes flow lines) when the run is healthy', async () => {
    getReportSpy.mockResolvedValue({
      status: 'ok',
      result: {
        flowLinesGeoJson: FLOW_LINES,
        hydrologyLibrary: 'pysheds',
        hydrologyDegraded: false,
        hydrologyDegradedReason: null,
      },
    })

    renderTile(client)

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
    getReportSpy.mockResolvedValue({
      status: 'ok',
      result: {
        flowLinesGeoJson: FLOW_LINES,
        hydrologyLibrary: 'native-d8',
        hydrologyDegraded: true,
        hydrologyDegradedReason: 'pysheds unavailable; native D8 fallback',
      },
    })

    renderTile(client)
    fireEvent.click(screen.getByTestId('hydrology-run'))

    const banner = await screen.findByTestId('tile-status-banner')
    expect(banner.textContent).toContain('Degraded')
    expect(banner.textContent).toContain('pysheds unavailable; native D8 fallback')
  })

  it('surfaces a run error honestly instead of a stale banner', async () => {
    getReportSpy.mockResolvedValue({
      status: 'error',
      error: 'DEM fetch failed upstream',
    })

    renderTile(client)
    fireEvent.click(screen.getByTestId('hydrology-run'))

    await waitFor(() => expect(screen.getByText('DEM fetch failed upstream')).toBeTruthy())
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
  })
})
