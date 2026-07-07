import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import type { QueueRow, ReviewerEngagementRow } from '@empressaio/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--h-text-muted)',
}

type QueueItem = ReviewerEngagementRow | (QueueRow & { _isLegacy: true })

function IntakeQueueTileInner() {
  const client = useCortexClient()
  const { engagementId, setEngagement, setLoading, queueRefreshToken } =
    useEngagement()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadingQueue, setLoadingQueue] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoadingQueue(true)
    client
      .getReviewerEngagements()
      .then((items) => {
        if (!cancelled) setQueue(items)
      })
      .catch(async (err: unknown) => {
        if (cancelled) return
        if (err instanceof Error && err.message.includes('404')) {
          try {
            const legacyQueue = await client.getQueue()
            if (!cancelled) {
              setQueue(legacyQueue.map((item) => ({ ...item, _isLegacy: true as const })))
            }
          } catch (fallbackErr: unknown) {
            if (!cancelled) {
              setError(
                fallbackErr instanceof Error
                  ? fallbackErr.message
                  : 'Failed to load queue',
              )
            }
          }
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load queue')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingQueue(false)
      })
    return () => {
      cancelled = true
    }
  }, [queueRefreshToken, client])

  async function selectCase(id: string) {
    setError(null)
    setLoading(true)
    try {
      const detail = await client.getEngagement(id)
      setEngagement(id, detail)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load engagement')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <TileStatusBanner status="live" label="Intake & Queue" />
      <span style={labelStyle}>Reviewer queue</span>
      {loadingQueue ? (
        <span
          style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-text-muted)' }}
        >
          Loading…
        </span>
      ) : error ? (
        <div
          role="alert"
          style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}
        >
          {error}
        </div>
      ) : queue.length === 0 ? (
        <span
          style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-text-muted)' }}
        >
          No cases in queue.
        </span>
      ) : (
        <ul
          data-testid="intake-queue-list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-xs)',
          }}
        >
          {queue.map((item) => {
            const itemEngagementId = '_isLegacy' in item ? item.engagementId : item.id
            const itemName = '_isLegacy' in item ? item.engagementName : item.name
            const itemStatus = item.status
            const itemDetail =
              '_isLegacy' in item
                ? `${item.openFindingCount} open · ${item.daysInQueue}d`
                : `${item.submissionCount} submissions`
            const itemId = '_isLegacy' in item ? item.id : item.id
            return (
              <li key={itemId}>
                <button
                  type="button"
                  data-testid={`queue-item-${itemEngagementId}`}
                  onClick={() => void selectCase(itemEngagementId)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 'var(--h-radius-sm)',
                    border:
                      engagementId === itemEngagementId
                        ? '1px solid var(--h-accent)'
                        : '1px solid var(--h-border-subtle)',
                    background:
                      engagementId === itemEngagementId
                        ? 'var(--h-surface-3)'
                        : 'transparent',
                    cursor: 'pointer',
                    fontSize: 'var(--h-text-sm)',
                    color: 'var(--h-text-primary)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{itemName}</div>
                  <div style={{ color: 'var(--h-text-muted)' }}>
                    {itemStatus} · {itemDetail}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function IntakeQueueTile() {
  return (
    <TileErrorBoundary label="Intake & Queue">
      <IntakeQueueTileInner />
    </TileErrorBoundary>
  )
}
