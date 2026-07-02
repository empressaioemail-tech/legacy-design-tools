import { useEffect, useState } from 'react'
import { useEngagement, TileStatusBanner } from '@hauska/tile-shell'
import type { Sheet } from '@hauska/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

function SheetExtractionTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (!engagementId) {
      setSheets([])
      setSelectedId(null)
      return
    }
    let cancelled = false
    client
      .getSheets(engagementId)
      .then((res) => {
        if (cancelled) return
        setSheets(res.sheets)
        setSelectedId(res.sheets[0]?.sheetId ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSheets([])
          setError(err instanceof Error ? err.message : 'Failed to load sheets')
        }
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  async function handleExtract() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    try {
      await client.extractSheets(engagementId)
      const res = await client.getSheets(engagementId)
      setSheets(res.sheets)
      if (res.sheets.length === 0) {
        setError('No sheets found — upload a snapshot with sheet PNGs first.')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sheet extraction failed')
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
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Sheet Extraction" />
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
      ) : sheets.length === 0 ? (
        <>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--h-text-sm)',
              color: 'var(--h-text-muted)',
            }}
          >
            No extracted sheets yet.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleExtract()}
            style={btnStyle(busy)}
          >
            {busy ? 'Extracting…' : 'Extract sheets'}
          </button>
        </>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-xs)',
          }}
        >
          {sheets.map((s) => (
            <li key={s.sheetId}>
              <button
                type="button"
                onClick={() => setSelectedId(s.sheetId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 'var(--h-space-sm)',
                  borderRadius: 'var(--h-radius-sm)',
                  border:
                    selectedId === s.sheetId
                      ? '1px solid var(--h-accent)'
                      : '1px solid var(--h-border-subtle)',
                  background: 'var(--h-surface-2)',
                  cursor: 'pointer',
                  fontSize: 'var(--h-text-sm)',
                  color: 'var(--h-text-primary)',
                }}
              >
                <strong>{s.label || 'Sheet'}</strong> — p.{s.pageNumber}
                {s.contentBody ? ' · extracted' : ''}
              </button>
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

function btnStyle(disabled: boolean) {
  return {
    padding: 'var(--h-space-sm) 14px',
    borderRadius: 'var(--h-radius-sm)',
    border: 'none',
    background: 'var(--h-accent)',
    color: '#fff',
    fontSize: 'var(--h-text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    alignSelf: 'flex-start' as const,
    opacity: disabled ? 0.7 : 1,
  }
}

export function SheetExtractionTile() {
  return (
    <TileErrorBoundary label="Sheet Extraction">
      <SheetExtractionTileInner />
    </TileErrorBoundary>
  )
}
