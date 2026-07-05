import { useState } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

function SubsurfaceTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    try {
      await client.runReport(engagementId, 'subsurface')
      const report = await client.getReport(engagementId, 'subsurface')
      if (report.status === 'unavailable') {
        setError(
          (report.result as { reason?: string })?.reason ??
            'USDA endpoint unreachable',
        )
        setEngagementReportResult('subsurface', {
          status: 'error',
          error: 'unavailable',
          result: report.result,
        })
        return
      }
      setResult(report.result)
      setEngagementReportResult('subsurface', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Subsurface run failed')
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
        status="partial"
        label="Subsurface Suitability"
        reason="SSURGO ECONNRESET — USDA TLS issue."
      />
      <button
        type="button"
        data-testid="subsurface-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run SSURGO subsurface'}
      </button>
      {error ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </span>
      ) : null}
      {result ? (
        <pre
          style={{
            fontSize: 10,
            overflow: 'auto',
            maxHeight: 160,
            background: 'var(--h-surface-2)',
            padding: 'var(--h-space-sm)',
            borderRadius: 'var(--h-radius-sm)',
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

export function SubsurfaceTile() {
  return (
    <TileErrorBoundary label="Subsurface Suitability">
      <SubsurfaceTileInner />
    </TileErrorBoundary>
  )
}
