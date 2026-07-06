import { useEffect, useState } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import type { ResponseTask } from '@empressaio/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

function ResponseTasksTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [tasks, setTasks] = useState<ResponseTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!engagementId) {
      setTasks([])
      return
    }
    let cancelled = false
    setLoading(true)
    client
      .getResponseTasks(engagementId)
      .then((res) => {
        if (!cancelled) setTasks(res.responseTasks)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load tasks')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Response Tasks" />
      {!engagementId ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
          }}
        >
          Select a case first.
        </p>
      ) : loading ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
          }}
        >
          Loading…
        </p>
      ) : tasks.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
          }}
        >
          Run compliance review first to generate response tasks.
        </p>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-sm)',
          }}
        >
          {tasks.map((t) => (
            <li
              key={t.entityId}
              style={{
                padding: 'var(--h-space-sm)',
                borderRadius: 'var(--h-radius-sm)',
                border: '1px solid var(--h-border-subtle)',
                fontSize: 'var(--h-text-sm)',
              }}
            >
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              <div style={{ color: 'var(--h-text-muted)', marginTop: 4 }}>
                {t.description}
              </div>
              <div style={{ marginTop: 4, color: 'var(--h-text-muted)' }}>
                Status: {t.state}
                {t.findingId ? ` · finding ${t.findingId.slice(0, 8)}…` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <div
          role="alert"
          style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}
        >
          {error}
        </div>
      ) : null}
    </div>
  )
}

export function ResponseTasksTile() {
  return (
    <TileErrorBoundary label="Response Tasks">
      <ResponseTasksTileInner />
    </TileErrorBoundary>
  )
}
