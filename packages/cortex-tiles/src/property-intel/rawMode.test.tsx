// Raw-mode (mode="raw") contract tests for the property-intel tiles that gained
// the callable "raw function" mode in Layer 3a (HazardProfile, LocalSetbacks).
//
// Same contract as PropertyBriefTile's mode="raw": the tile renders NONE of its
// own UI and invokes the `children` render-prop with its live data + state, so a
// consuming app calls the tile's function and renders in its own look-and-feel.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { HazardProfileTile, type HazardProfileRaw } from './HazardProfileTile'
import { LocalSetbacksTile, type LocalSetbacksRaw } from './LocalSetbacksTile'
import { EngagementProvider } from '@empressaio/tile-shell'
import { CortexProvider } from '../CortexProvider'
import type { CortexClient } from '@empressaio/cortex-client'

function renderRaw(node: React.ReactNode, client: CortexClient, initialParcel: Record<string, unknown>) {
  return render(
    <CortexProvider client={client}>
      <EngagementProvider initialParcel={initialParcel}>{node}</EngagementProvider>
    </CortexProvider>,
  )
}

describe('HazardProfileTile: mode="raw" is a callable render-prop, not chrome', () => {
  let client: CortexClient
  let getReportSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getReportSpy = vi.fn().mockResolvedValue({ status: 'not-run' })
    client = {
      runReport: vi.fn().mockResolvedValue({}),
      getReport: getReportSpy,
      fetch: vi.fn(),
    } as unknown as CortexClient
  })

  it('renders no tile UI and hands run() + result to the consumer', async () => {
    // handleRun path returns a flood layer.
    getReportSpy.mockResolvedValue({
      status: 'ok',
      result: { layers: [{ layerKind: 'fema-flood', payload: { FLD_ZONE: 'AE' } }] },
    })

    let captured: HazardProfileRaw | null = null
    renderRaw(
      <HazardProfileTile mode="raw">
        {(raw) => {
          captured = raw
          return <span data-testid="consumer">{raw.floodZone ?? 'no-zone'}</span>
        }}
      </HazardProfileTile>,
      client,
      { engagementId: 'eng-hz' },
    )

    // No tile chrome — the tile's Run button / status banner are absent.
    expect(screen.queryByText(/Run hazard/)).toBeNull()
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()
    expect(captured).not.toBeNull()
    expect(typeof captured!.run).toBe('function')

    await captured!.run()
    await waitFor(() => expect(screen.getByTestId('consumer').textContent).toBe('AE'))
    expect(client.runReport).toHaveBeenCalledWith('eng-hz', 'hazard')
  })
})

describe('LocalSetbacksTile: mode="raw" is a callable render-prop, not chrome', () => {
  it('auto-loads the setback table off jurisdiction and hands it to the consumer', async () => {
    const table = {
      jurisdictionDisplayName: 'Bastrop, TX',
      districts: [{ district_name: 'R-1', front_ft: 25, rear_ft: 10 }],
    }
    const fetchSpy = vi.fn().mockResolvedValue(table)
    const client = { fetch: fetchSpy } as unknown as CortexClient

    let captured: LocalSetbacksRaw | null = null
    renderRaw(
      <LocalSetbacksTile mode="raw">
        {(raw) => {
          captured = raw
          return (
            <span data-testid="consumer">
              {raw.loading ? 'loading' : `${raw.districts.length} districts`}
            </span>
          )
        }}
      </LocalSetbacksTile>,
      client,
      { engagementId: 'eng-sb', jurisdiction: 'bastrop-tx' },
    )

    // No tile chrome (no <table>, no status banner) — consumer renders its own.
    expect(document.querySelector('table')).toBeNull()
    expect(screen.queryByTestId('tile-status-banner')).toBeNull()

    // Auto-fetch (no run() needed — matches PropertyBriefTile's mount load).
    await waitFor(() =>
      expect(screen.getByTestId('consumer').textContent).toBe('1 districts'),
    )
    expect(fetchSpy).toHaveBeenCalledWith('/local/setbacks/bastrop-tx')
    expect(captured!.table?.jurisdictionDisplayName).toBe('Bastrop, TX')
    expect(captured!.jurisdiction).toBe('bastrop-tx')
  })

  it('raw mode with NO children renders nothing (headless, no crash)', () => {
    const client = { fetch: vi.fn().mockResolvedValue({ districts: [] }) } as unknown as CortexClient
    const { container } = renderRaw(
      <LocalSetbacksTile mode="raw" />,
      client,
      { engagementId: 'eng-sb', jurisdiction: 'x' },
    )
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
