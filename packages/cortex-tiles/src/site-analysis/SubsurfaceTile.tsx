import { useState } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

export type SubsurfaceMode = 'full' | 'card' | 'raw'

/**
 * The raw-mode payload handed to a `children` render-prop when `mode="raw"`.
 * Mirrors PropertyBriefTile's headless escape hatch: the tile owns data + state,
 * the consumer renders in its own look-and-feel. `run` is exposed because the
 * SSURGO subsurface suitability is fetched on demand (USDA SDA). `result` is the
 * raw report body (SSURGO attributes); shape is provider-defined, so it is
 * surfaced as `unknown` exactly as the tile holds it.
 */
export type SubsurfaceRaw = {
  result: unknown
  busy: boolean
  error: string | null
  run: () => Promise<void>
}

function SubsurfaceTileInner({
  mode = 'full',
  children,
}: {
  mode?: SubsurfaceMode
  children?: (raw: SubsurfaceRaw) => React.ReactNode
}) {
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

  // raw mode: headless escape hatch — the tile owns data + state, consumer
  // renders. Matches PropertyBriefTile's mode="raw" render-prop contract.
  if (mode === 'raw') {
    return <>{children ? children({ result, busy, error, run: handleRun }) : null}</>
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

export function SubsurfaceTile({
  mode = 'full',
  children,
}: {
  mode?: SubsurfaceMode
  children?: (raw: SubsurfaceRaw) => React.ReactNode
} = {}) {
  return (
    <TileErrorBoundary label="Subsurface Suitability">
      <SubsurfaceTileInner mode={mode} children={children} />
    </TileErrorBoundary>
  )
}
