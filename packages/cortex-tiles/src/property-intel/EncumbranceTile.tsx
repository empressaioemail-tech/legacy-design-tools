import { useState } from 'react'
import { useEngagement } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { ReportTileShell } from './ReportTileShell'

function EncumbranceTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<unknown>(null)

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    try {
      await client.runReport(engagementId, 'encumbrances')
      const report = await client.getReport(engagementId, 'encumbrances')
      if (report.status === 'not-run') {
        setError(
          'No encumbrances on file — upload CC&R or deed restriction PDFs via the engagement encumbrance route.',
        )
        setResult(null)
        return
      }
      setResult(report.result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Encumbrance load failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ReportTileShell
      label="Encumbrance Report"
      engagementId={engagementId}
      busy={busy}
      error={error}
      onRun={() => void handleRun()}
      result={result}
      runLabel="Load encumbrances"
      emptyHint="Load liens, deed restrictions, and CC&Rs stored against this engagement."
    />
  )
}

export function EncumbranceTile() {
  return (
    <TileErrorBoundary label="Encumbrance Report">
      <EncumbranceTileInner />
    </TileErrorBoundary>
  )
}
