import { useState } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'
import { fetchSubsurface } from './siteReports'

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
      // Single source of truth: the pure fetchSubsurface function.
      const state = await fetchSubsurface(
        client.config.baseUrl,
        { engagementId },
        undefined,
        { getToken: client.config.getToken },
      )
      if (state.status === 'unavailable') {
        setError(state.detail ?? 'USDA endpoint unreachable')
        setEngagementReportResult('subsurface', {
          status: 'error',
          error: 'unavailable',
        })
        return
      }
      if (state.status === 'error') {
        setError(state.message)
        return
      }
      if (state.status === 'not-run') {
        setError('No subsurface result recorded yet — retry.')
        return
      }
      setResult(state.result)
      setEngagementReportResult('subsurface', {
        status: 'ok',
        result: state.result,
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
      {error ? (
        <TileStatusBanner
          status="degraded"
          label="Subsurface Suitability"
          reason={error}
        />
      ) : (
        <TileStatusBanner status="live" label="Subsurface Suitability" />
      )}
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
