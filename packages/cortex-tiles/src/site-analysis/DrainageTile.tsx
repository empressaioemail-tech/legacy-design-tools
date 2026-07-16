import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'

type DrainageReportResult = {
  flowLinesGeoJson?: { type: string; features: unknown[] }
  drainageZonesGeoJson?: { type: string; features: unknown[] }
  hydrologyDegraded?: boolean
  hydrologyDegradedReason?: string | null
}

export type DrainageMode = 'full' | 'card' | 'raw'

/**
 * The raw-mode payload handed to a `children` render-prop when `mode="raw"`.
 * Mirrors PropertyBriefTile's headless escape hatch: the tile owns data + state,
 * the consumer renders in its own look-and-feel. `run` is exposed because
 * drainage is computed on demand (engine run) and pushes flow-line + drainage-
 * zone overlays into the shared spatial context.
 */
export type DrainageRaw = {
  result: DrainageReportResult | null
  summary: string | null
  degradedReason: string | null
  busy: boolean
  error: string | null
  run: () => Promise<void>
}

function DrainageTileInner({
  mode = 'full',
  children,
}: {
  mode?: DrainageMode
  children?: (raw: DrainageRaw) => React.ReactNode
}) {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [degradedReason, setDegradedReason] = useState<string | null>(null)
  const [result, setResult] = useState<DrainageReportResult | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setSummary(null)
    setDegradedReason(null)
    setResult(null)
    try {
      await client.runReport(engagementId, 'drainage')
      const report = await client.getReport(engagementId, 'drainage')
      if (report.status === 'not-run') {
        // The run POST surfaces real failures as 4xx/5xx (caught below),
        // so a lingering not-run here means no drainage result exists yet
        // for this engagement — never blame geocoding for it.
        setError('No drainage result recorded yet — retry, and run Topography first if it has not run.')
        return
      }
      if (report.status === 'error') {
        setError(report.error ?? 'Drainage run failed')
        return
      }
      setEngagementReportResult('drainage', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
      })
      const result = report.result as DrainageReportResult
      setResult(result ?? null)
      if (result?.hydrologyDegraded) {
        setDegradedReason(
          result.hydrologyDegradedReason ??
            'pysheds unavailable; native D8 fallback',
        )
      }
      const pushed: string[] = []
      // SEAM: kind === map-renderer OverlaySpec.layerKey (MapTile.toMapOverlays).
      if (result?.flowLinesGeoJson) {
        pushOverlay({
          id: 'drainage-flow',
          kind: 'hydrology-flow',
          label: 'Drainage flow lines',
          geojson: result.flowLinesGeoJson,
        })
        const n = Array.isArray(result.flowLinesGeoJson.features)
          ? result.flowLinesGeoJson.features.length
          : 0
        pushed.push(`${n} flow line${n === 1 ? '' : 's'}`)
      }
      if (result?.drainageZonesGeoJson) {
        pushOverlay({
          id: 'drainage-zones',
          kind: 'drainage-zones',
          label: 'Drainage zones',
          geojson: result.drainageZonesGeoJson,
          opacity: 0.4,
        })
        const n = Array.isArray(result.drainageZonesGeoJson.features)
          ? result.drainageZonesGeoJson.features.length
          : 0
        pushed.push(`${n} drainage zone${n === 1 ? '' : 's'}`)
      }
      setSummary(
        pushed.length
          ? `${pushed.join(' · ')} · pushed to Map overlay stack.`
          : 'Drainage ran, but no geometry was returned.',
      )
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Drainage run failed')
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
          ? children({ result, summary, degradedReason, busy, error, run: handleRun })
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
          label="Drainage"
          reason={degradedReason}
        />
      ) : (
        <TileStatusBanner status="live" label="Drainage" />
      )}
      <button
        type="button"
        data-testid="drainage-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run drainage'}
      </button>
      {summary ? (
        <span style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-success)' }}>
          {summary}
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

export function DrainageTile({
  mode = 'full',
  children,
}: {
  mode?: DrainageMode
  children?: (raw: DrainageRaw) => React.ReactNode
} = {}) {
  return (
    <TileErrorBoundary label="Drainage">
      <DrainageTileInner mode={mode} children={children} />
    </TileErrorBoundary>
  )
}
