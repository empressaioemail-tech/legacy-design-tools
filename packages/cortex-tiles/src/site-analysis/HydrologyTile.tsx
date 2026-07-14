import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

type HydrologyReportResult = {
  flowLinesGeoJson?: { type: string; features: unknown[] }
  hydrologyLibrary?: string | null
  hydrologyDegraded?: boolean
  hydrologyDegradedReason?: string | null
}

function HydrologyTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [degradedReason, setDegradedReason] = useState<string | null>(null)
  const [library, setLibrary] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setDegradedReason(null)
    try {
      await client.runReport(engagementId, 'hydrology')
      const report = await client.getReport(engagementId, 'hydrology')
      if (report.status === 'error') {
        setError(report.error ?? 'Hydrology run failed')
        return
      }
      setEngagementReportResult('hydrology', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
        error: report.error,
      })
      const result = report.result as HydrologyReportResult | undefined
      setLibrary(result?.hydrologyLibrary ?? null)
      setDegradedReason(
        result?.hydrologyDegraded
          ? (result.hydrologyDegradedReason ??
              'pysheds unavailable; native D8 fallback')
          : null,
      )
      const flowLines = result?.flowLinesGeoJson
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
      {degradedReason ? (
        <TileStatusBanner
          status="degraded"
          label="Hydrology"
          reason={degradedReason}
        />
      ) : (
        <TileStatusBanner status="live" label="Hydrology" />
      )}
      <button
        type="button"
        data-testid="hydrology-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run hydrology'}
      </button>
      {library ? (
        <span style={{ fontSize: 'var(--h-text-sm)', opacity: 0.75 }}>
          Engine: {library}
        </span>
      ) : null}
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
