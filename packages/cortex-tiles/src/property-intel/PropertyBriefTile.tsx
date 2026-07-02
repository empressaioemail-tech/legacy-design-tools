import { useState } from 'react'
import { useEngagement } from '@hauska/tile-shell'
import type { CortexClient } from '@hauska/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { ReportTileShell } from './ReportTileShell'

async function pollReport(
  client: CortexClient,
  engagementId: string,
  type: string,
  attempts = 12,
): Promise<{ status: string; result?: unknown; error?: string }> {
  for (let i = 0; i < attempts; i++) {
    const report = await client.getReport(engagementId, type)
    if (report.status !== 'running') return report
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { status: 'running' }
}

function PropertyBriefTileInner() {
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
      await client.runReport(engagementId, 'property-brief')
      const report = await pollReport(client, engagementId, 'property-brief')
      if (report.status === 'error') {
        setError(report.error ?? 'Property brief generation failed')
        return
      }
      if (report.status === 'running') {
        setError('Brief still generating — try again shortly.')
        return
      }
      if (report.status === 'not-run') {
        setError('No briefing sources yet — ensure engagement is geocoded.')
        return
      }
      setResult(report.result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Property brief run failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ReportTileShell
      label="Property Brief"
      engagementId={engagementId}
      busy={busy}
      error={error}
      onRun={() => void handleRun()}
      result={result}
      emptyHint="Run property brief to fetch site context, parcel layers, and narrative sections."
    />
  )
}

export function PropertyBriefTile() {
  return (
    <TileErrorBoundary label="Property Brief">
      <PropertyBriefTileInner />
    </TileErrorBoundary>
  )
}
