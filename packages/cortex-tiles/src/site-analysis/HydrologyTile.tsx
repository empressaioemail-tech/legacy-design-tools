import { useState } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { runButtonStyle } from './TopographyTile'
import { fetchHydrology } from './siteReports'

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
      // Single source of truth: the pure fetchHydrology function (React-free,
      // vanilla-consumable) does the run+get+state mapping. The component only
      // renders the honest state it returns.
      const state = await fetchHydrology(
        client.config.baseUrl,
        { engagementId },
        undefined,
        { getToken: client.config.getToken },
      )
      if (state.status === 'error') {
        setError(state.message)
        return
      }
      if (state.status === 'not-run' || state.status === 'unavailable') {
        setError('No hydrology result recorded yet — retry.')
        return
      }
      setEngagementReportResult('hydrology', {
        status: 'ok',
        result: state.result,
      })
      setLibrary(state.result?.hydrologyLibrary ?? null)
      setDegradedReason(state.status === 'degraded' ? state.reason : null)
      const flowLines = state.result?.flowLinesGeoJson
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
