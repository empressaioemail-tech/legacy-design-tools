// Raw-mode (mode="raw") contract tests for the site-analysis tiles.
//
// Layer 3a of the Brief-as-spine-consumer program: every library tile exposes a
// callable "raw function" mode so a consuming app can CALL the tile's function
// (get its data + run trigger) and render in its OWN look-and-feel, instead of
// importing the tile's React chrome. The contract replicates PropertyBriefTile:
// mode="raw" renders NOTHING of its own — it invokes the `children` render-prop
// with the tile's live data + state, and the tile still owns the data-fetch.
//
// These tests prove, per tile, that:
//   1. mode="raw" renders NONE of the tile's own UI (no run button, no banner);
//   2. the render-prop receives the tile's data/logic (including the `run` fn);
//   3. calling `run()` drives the mocked client and surfaces the result to the
//      consumer — i.e. the raw payload IS the tile's function, not chrome.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { HydrologyTile, type HydrologyRaw } from './HydrologyTile'
import { DrainageTile, type DrainageRaw } from './DrainageTile'
import { TopographyTile, type TopographyRaw } from './TopographyTile'
import { SubsurfaceTile, type SubsurfaceRaw } from './SubsurfaceTile'
import { EngagementProvider, SpatialProvider } from '@empressaio/tile-shell'
import { CortexProvider } from '../CortexProvider'
import type { CortexClient } from '@empressaio/cortex-client'

const CONTOURS = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }],
}

function makeClient(getReportResult: unknown): CortexClient {
  return {
    runReport: vi.fn().mockResolvedValue({}),
    getReport: vi.fn().mockResolvedValue(getReportResult),
    fetch: vi.fn(),
  } as unknown as CortexClient
}

function renderRaw(node: React.ReactNode, client: CortexClient) {
  return render(
    <CortexProvider client={client}>
      <EngagementProvider initialParcel={{ engagementId: 'eng-raw' }}>
        <SpatialProvider>{node}</SpatialProvider>
      </EngagementProvider>
    </CortexProvider>,
  )
}

describe('site-analysis tiles: mode="raw" is a callable render-prop, not chrome', () => {
  beforeEach(() => vi.clearAllMocks())

  it('HydrologyTile raw: no tile UI, exposes run() + result to the consumer', async () => {
    const client = makeClient({
      status: 'ok',
      result: {
        flowLinesGeoJson: CONTOURS,
        hydrologyLibrary: 'pysheds',
        hydrologyDegraded: false,
        hydrologyDegradedReason: null,
      },
    })

    let captured: HydrologyRaw | null = null
    renderRaw(
      <HydrologyTile mode="raw">
        {(raw) => {
          captured = raw
          // Consumer renders in its OWN look-and-feel — a bare span, no tile chrome.
          return <span data-testid="consumer">{raw.library ?? 'no-lib'}</span>
        }}
      </HydrologyTile>,
      client,
    )

    // Raw mode renders NONE of the tile's own UI.
    expect(screen.queryByTestId('hydrology-run')).toBeNull()
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
    // The consumer's own render is what shows.
    expect(screen.getByTestId('consumer')).toBeTruthy()
    // The render-prop got the tile's function surface.
    expect(captured).not.toBeNull()
    expect(typeof captured!.run).toBe('function')
    expect(captured!.result).toBeNull() // nothing fetched until run()

    // Calling the tile's function (run) drives the client and surfaces data.
    await captured!.run()
    await waitFor(() => expect(screen.getByTestId('consumer').textContent).toBe('pysheds'))
    expect(client.runReport).toHaveBeenCalledWith('eng-raw', 'hydrology')
  })

  it('DrainageTile raw: no tile UI, run() surfaces the drainage result', async () => {
    const client = makeClient({
      status: 'ok',
      result: {
        flowLinesGeoJson: CONTOURS,
        drainageZonesGeoJson: CONTOURS,
        hydrologyDegraded: false,
      },
    })

    let captured: DrainageRaw | null = null
    renderRaw(
      <DrainageTile mode="raw">
        {(raw) => {
          captured = raw
          return (
            <span data-testid="consumer">
              {raw.result ? 'has-result' : 'empty'}
            </span>
          )
        }}
      </DrainageTile>,
      client,
    )

    expect(screen.queryByTestId('drainage-run')).toBeNull()
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
    expect(captured).not.toBeNull()
    expect(typeof captured!.run).toBe('function')

    await captured!.run()
    await waitFor(() => expect(screen.getByTestId('consumer').textContent).toBe('has-result'))
    expect(client.runReport).toHaveBeenCalledWith('eng-raw', 'drainage')
  })

  it('TopographyTile raw: no tile UI, run() surfaces contours + summary', async () => {
    const client = makeClient({ status: 'ok', result: { contoursGeoJson: CONTOURS } })

    let captured: TopographyRaw | null = null
    renderRaw(
      <TopographyTile mode="raw">
        {(raw) => {
          captured = raw
          return <span data-testid="consumer">{raw.summary ?? 'no-summary'}</span>
        }}
      </TopographyTile>,
      client,
    )

    expect(screen.queryByTestId('topography-run')).toBeNull()
    expect(captured).not.toBeNull()
    expect(typeof captured!.run).toBe('function')

    await captured!.run()
    await waitFor(() =>
      expect(screen.getByTestId('consumer').textContent).toContain('contour'),
    )
    expect(captured!.result?.contoursGeoJson).toBeTruthy()
    expect(client.runReport).toHaveBeenCalledWith('eng-raw', 'topography')
  })

  it('SubsurfaceTile raw: no tile UI, run() surfaces the SSURGO body', async () => {
    const client = makeClient({ status: 'ok', result: { muName: 'Silty clay loam' } })

    let captured: SubsurfaceRaw | null = null
    renderRaw(
      <SubsurfaceTile mode="raw">
        {(raw) => {
          captured = raw
          const body = raw.result as { muName?: string } | null
          return <span data-testid="consumer">{body?.muName ?? 'empty'}</span>
        }}
      </SubsurfaceTile>,
      client,
    )

    expect(screen.queryByTestId('subsurface-run')).toBeNull()
    expect(captured).not.toBeNull()
    expect(typeof captured!.run).toBe('function')

    await captured!.run()
    await waitFor(() =>
      expect(screen.getByTestId('consumer').textContent).toBe('Silty clay loam'),
    )
    expect(client.runReport).toHaveBeenCalledWith('eng-raw', 'subsurface')
  })

  it('raw mode with NO children renders nothing (headless, no crash)', () => {
    const client = makeClient({ status: 'ok', result: {} })
    const { container } = renderRaw(<HydrologyTile mode="raw" />, client)
    expect(container.querySelector('[data-testid="hydrology-run"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
