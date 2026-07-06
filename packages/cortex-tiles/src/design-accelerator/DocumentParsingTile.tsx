import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const mutedText: CSSProperties = {
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function readStr(x: Record<string, unknown>, key: string): string | null {
  const v = x[key]
  return typeof v === 'string' && v.trim() ? v : null
}

type DocView = {
  key: string
  title: string
  documentType: string | null
  parsedText: string | null
}

function toDocView(x: unknown, index: number): DocView {
  if (!isRecord(x)) {
    return { key: String(index), title: `Document ${index + 1}`, documentType: null, parsedText: null }
  }
  const title =
    readStr(x, 'title') ?? readStr(x, 'filename') ?? readStr(x, 'name') ?? `Document ${index + 1}`
  const parsedText =
    readStr(x, 'parsedText') ??
    readStr(x, 'contentBody') ??
    readStr(x, 'text') ??
    readStr(x, 'summary')
  const key =
    readStr(x, 'id') ?? readStr(x, 'documentId') ?? readStr(x, 'entityId') ?? String(index)
  return {
    key,
    title,
    documentType: readStr(x, 'documentType'),
    parsedText,
  }
}

function DocItem({ view }: { view: DocView }) {
  const parsed = view.parsedText != null
  const isLong = parsed && (view.parsedText as string).length > 240
  return (
    <li
      style={{
        border: '1px solid var(--h-border-subtle)',
        borderRadius: 'var(--h-radius-sm)',
        padding: '8px 10px',
        background: 'var(--h-surface-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-primary)',
          }}
        >
          {view.title}
        </span>
        {view.documentType ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--h-accent)',
              border: '1px solid var(--h-accent)',
              borderRadius: 'var(--h-radius-sm)',
              padding: '1px 6px',
            }}
          >
            {view.documentType}
          </span>
        ) : null}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: parsed ? 'var(--h-success)' : 'var(--h-warning)',
          }}
        >
          {parsed ? 'parsed' : 'not parsed'}
        </span>
      </div>

      {parsed ? (
        isLong ? (
          <details>
            <summary style={{ ...mutedText, cursor: 'pointer' }}>
              Parsed text ({(view.parsedText as string).length} chars)
            </summary>
            <div
              style={{
                fontSize: 'var(--h-text-sm)',
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                marginTop: 4,
              }}
            >
              {view.parsedText}
            </div>
          </details>
        ) : (
          <div
            style={{
              fontSize: 'var(--h-text-sm)',
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {view.parsedText}
          </div>
        )
      ) : (
        <span style={mutedText}>No parsed text on this document.</span>
      )}
    </li>
  )
}

function DocumentParsingTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [docs, setDocs] = useState<unknown[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDocs([])
    setError(null)
    if (!engagementId) return
    setLoading(true)
    client
      .fetch<{ attachedDocuments: unknown[] }>(
        '/engagements/' + engagementId + '/attached-documents',
      )
      .then((res) => {
        if (!cancelled)
          setDocs(Array.isArray(res?.attachedDocuments) ? res.attachedDocuments : [])
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load documents')
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
        gap: 10,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Document Parsing" />

      {!engagementId ? (
        <span style={mutedText}>Select a case.</span>
      ) : loading ? (
        <span style={mutedText}>Loading…</span>
      ) : error ? (
        <div role="alert" style={{ ...mutedText, color: 'var(--h-error)' }}>
          {error}
        </div>
      ) : docs.length === 0 ? (
        <span style={mutedText}>No attached documents for this engagement.</span>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-xs)',
          }}
        >
          {docs.map((d, i) => {
            const view = toDocView(d, i)
            return <DocItem key={view.key} view={view} />
          })}
        </ul>
      )}
    </div>
  )
}

export function DocumentParsingTile() {
  return (
    <TileErrorBoundary label="Document Parsing">
      <DocumentParsingTileInner />
    </TileErrorBoundary>
  )
}
