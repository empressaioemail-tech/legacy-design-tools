import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@hauska/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

function DrainageTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    try {
      await client.runReport(engagementId, 'drainage')
      const report = await client.getReport(engagementId, 'drainage')
      setEngagementReportResult('drainage', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
      })
      const result = report.result as {
        flowLinesGeoJson?: { type: string; features: unknown[] }
        drainageZonesGeoJson?: { type: string; features: unknown[] }
      }
      if (result?.flowLinesGeoJson) {
        pushOverlay({
          id: 'drainage-flow',
          kind: 'hydrology-flow',
          label: 'Drainage flow lines',
          geojson: result.flowLinesGeoJson,
        })
      }
      if (result?.drainageZonesGeoJson) {
        pushOverlay({
          id: 'drainage-zones',
          kind: 'drainage-zones',
          label: 'Drainage zones',
          geojson: result.drainageZonesGeoJson,
          opacity: 0.4,
        })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Drainage run failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm)',
      }}
    >
      <TileStatusBanner status="live" label="Drainage" />
      <button
        type="button"
        data-testid="drainage-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run drainage'}
      </button>
      {error ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

export function DrainageTile() {
  return (
    <TileErrorBoundary label="Drainage">
      <DrainageTileInner />
    </TileErrorBoundary>
  )
}
