import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'
import { fetchDrainage } from './siteReports'

function DrainageTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [degradedReason, setDegradedReason] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setSummary(null)
    setDegradedReason(null)
    try {
      // Single source of truth: the pure fetchDrainage function.
      const state = await fetchDrainage(
        client.config.baseUrl,
        { engagementId },
        undefined,
        { getToken: client.config.getToken },
      )
      if (state.status === 'not-run') {
        // The run POST surfaces real failures as 4xx/5xx (caught below),
        // so a lingering not-run here means no drainage result exists yet
        // for this engagement — never blame geocoding for it.
        setError('No drainage result recorded yet — retry, and run Topography first if it has not run.')
        return
      }
      if (state.status === 'unavailable') {
        setError('No drainage result recorded yet — retry, and run Topography first if it has not run.')
        return
      }
      if (state.status === 'error') {
        setError(state.message)
        return
      }
      setEngagementReportResult('drainage', {
        status: 'ok',
        result: state.result,
      })
      const result = state.result
      if (state.status === 'degraded') {
        setDegradedReason(state.reason)
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

export function DrainageTile() {
  return (
    <TileErrorBoundary label="Drainage">
      <DrainageTileInner />
    </TileErrorBoundary>
  )
}
