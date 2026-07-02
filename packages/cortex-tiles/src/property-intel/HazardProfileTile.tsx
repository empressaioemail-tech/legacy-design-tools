import { useState } from 'react'
import { useEngagement } from '@hauska/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { ReportTileShell } from './ReportTileShell'

function HazardProfileTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<unknown>(null)
  const [quotaBanner, setQuotaBanner] = useState<string | null>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setQuotaBanner(null)
    try {
      await client.runReport(engagementId, 'hazard')
      const report = await client.getReport(engagementId, 'hazard')
      if (report.status === 'error') {
        setError(report.error ?? 'Hazard profile failed')
        return
      }
      if (report.status === 'not-run') {
        setError('No hazard layers returned — check geocode and retry.')
        return
      }
      const payload = report.result as { quotaExhausted?: boolean }
      if (payload?.quotaExhausted) {
        setQuotaBanner(
          'Hazard data quota exhausted — demo keys expire ~2026-07-06.',
        )
      }
      setResult(report.result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Hazard run failed'
      if (msg.includes('429') || msg.includes('quota')) {
        setQuotaBanner(
          'Hazard data quota exhausted — demo keys expire ~2026-07-06.',
        )
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <ReportTileShell
      label="Hazard Profile"
      engagementId={engagementId}
      busy={busy}
      error={error}
      onRun={() => void handleRun()}
      result={result}
      runLabel="Run hazard profile"
      quotaBanner={quotaBanner}
      emptyHint="Run hazard profile for FEMA flood zone and Cotality peril layers."
    />
  )
}

export function HazardProfileTile() {
  return (
    <TileErrorBoundary label="Hazard Profile">
      <HazardProfileTileInner />
    </TileErrorBoundary>
  )
}
