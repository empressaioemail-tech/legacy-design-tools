import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

function HydrologyTileInner() {
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
      await client.runReport(engagementId, 'hydrology')
      const report = await client.getReport(engagementId, 'hydrology')
      setEngagementReportResult('hydrology', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
        error: report.error,
      })
      const flowLines = (
        report.result as {
          flowLinesGeoJson?: { type: string; features: unknown[] }
        }
      )?.flowLinesGeoJson
      if (flowLines) {
        pushOverlay({
          id: 'hydrology-flow',
          kind: 'hydrology-flow',
          label: 'Hydrology flow lines',
          geojson: flowLines,
        })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Hydrology run failed')
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
      <TileStatusBanner
        status="degraded"
        label="Hydrology"
        reason="pysheds not installed in Cloud Run worker."
      />
      <button
        type="button"
        data-testid="hydrology-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run hydrology'}
      </button>
      {error ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

export function HydrologyTile() {
  return (
    <TileErrorBoundary label="Hydrology">
      <HydrologyTileInner />
    </TileErrorBoundary>
  )
}
