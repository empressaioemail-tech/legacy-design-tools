import { useState, type CSSProperties } from 'react'
import { useEngagement, useSpatial, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

function TopographyTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagementReportResult } = useEngagement()
  const { pushOverlay } = useSpatial()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setSummary(null)
    try {
      await client.runReport(engagementId, 'topography')
      const report = await client.getReport(engagementId, 'topography')
      if (report.status === 'not-run') {
        setError('No topography yet — ensure the parcel is geocoded, then retry.')
        return
      }
      if (report.status === 'error') {
        setError(report.error ?? 'Topography run failed')
        return
      }
      setEngagementReportResult('topography', {
        status: report.status === 'ok' ? 'ok' : 'error',
        result: report.result,
        error: report.error,
      })
      const geojson = (
        report.result as {
          contoursGeoJson?: { type: string; features: unknown[] }
        }
      )?.contoursGeoJson
      if (geojson) {
        // SEAM: kind === map-renderer OverlaySpec.layerKey (MapTile.toMapOverlays).
        pushOverlay({
          id: 'topography-contours',
          kind: 'topography-contours',
          label: 'Topography contours',
          geojson,
          opacity: 0.7,
        })
        const n = Array.isArray(geojson.features) ? geojson.features.length : 0
        setSummary(`${n} contour line${n === 1 ? '' : 's'} generated · pushed to Map overlay stack.`)
      } else {
        setSummary('Topography ran, but no contour geometry was returned.')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Topography run failed')
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
      <TileStatusBanner status="live" label="Topography" />
      <button
        type="button"
        data-testid="topography-run"
        disabled={!engagementId || busy}
        onClick={() => void handleRun()}
        style={runButtonStyle(!engagementId || busy)}
      >
        {busy ? 'Running…' : 'Run topography'}
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

export function TopographyTile() {
  return (
    <TileErrorBoundary label="Topography">
      <TopographyTileInner />
    </TileErrorBoundary>
  )
}

export function runButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: 'var(--h-space-sm) 14px',
    borderRadius: 'var(--h-radius-sm)',
    border: 'none',
    background: 'var(--h-accent)',
    color: '#fff',
    fontSize: 'var(--h-text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    alignSelf: 'flex-start',
  }
}
