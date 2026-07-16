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

export type HydrologyMode = 'full' | 'card' | 'raw'

/**
 * The raw-mode payload handed to a `children` render-prop when `mode="raw"`.
 * Mirrors PropertyBriefTile's headless escape hatch: the tile owns data + state,
 * the consumer renders in its own look-and-feel. `run` is exposed because
 * hydrology is computed on demand (engine pysheds/D8 run) and pushes flow-line
 * overlays into the shared spatial context — the consumer triggers the run and
 * reads the result + degraded state, rendering however it wants.
 */
export type HydrologyRaw = {
  result: HydrologyReportResult | null
  library: string | null
  degradedReason: string | null
  busy: boolean
  error: string | null
  run: () => Promise<void>
}

function HydrologyTileInner({
  mode = 'full',
  children,
}: {
  mode?: HydrologyMode
  children?: (raw: HydrologyRaw) => React.ReactNode
}) {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [degradedReason, setDegradedReason] = useState<string | null>(null)
  const [library, setLibrary] = useState<string | null>(null)
  const [result, setResult] = useState<HydrologyReportResult | null>(null)

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
      const runResult = report.result as HydrologyReportResult | undefined
      setResult(runResult ?? null)
      setLibrary(runResult?.hydrologyLibrary ?? null)
      setDegradedReason(
        runResult?.hydrologyDegraded
          ? (runResult.hydrologyDegradedReason ??
              'pysheds unavailable; native D8 fallback')
          : null,
      )
      const flowLines = runResult?.flowLinesGeoJson
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

  // raw mode: headless escape hatch — the tile owns data + state, consumer
  // renders. Matches PropertyBriefTile's mode="raw" render-prop contract.
  if (mode === 'raw') {
    return (
      <>
        {children
          ? children({ result, library, degradedReason, busy, error, run: handleRun })
          : null}
      </>
    )
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

export function HydrologyTile({
  mode = 'full',
  children,
}: {
  mode?: HydrologyMode
  children?: (raw: HydrologyRaw) => React.ReactNode
} = {}) {
  return (
    <TileErrorBoundary label="Hydrology">
      <HydrologyTileInner mode={mode} children={children} />
    </TileErrorBoundary>
  )
}
