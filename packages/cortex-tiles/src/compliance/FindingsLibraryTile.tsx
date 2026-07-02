import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@hauska/tile-shell'
import type { EngagementSubmissionSummary } from '@hauska/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--h-text-muted)',
}

const mutedText: CSSProperties = {
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
}

// ─── Defensive readers for the opaque finding wire ───────────────────
// The findings array is `unknown[]` — the wire carries no typed shape. Read
// common string fields when present without asserting a shape.
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function readStr(x: Record<string, unknown>, key: string): string | null {
  const v = x[key]
  return typeof v === 'string' && v.trim() ? v : null
}

type FindingView = {
  key: string
  codeSection: string | null
  description: string | null
  severity: string | null
  status: string | null
  determination: string | null
}

function toFindingView(x: unknown, index: number): FindingView {
  if (!isRecord(x)) {
    return {
      key: String(index),
      codeSection: null,
      description: null,
      severity: null,
      status: null,
      determination: null,
    }
  }
  const idField = readStr(x, 'findingId') ?? readStr(x, 'id')
  return {
    key: idField ?? String(index),
    codeSection: readStr(x, 'codeSection'),
    description: readStr(x, 'description'),
    severity: readStr(x, 'severity'),
    status: readStr(x, 'status'),
    determination: readStr(x, 'determination'),
  }
}

function FindingCard({ raw, view }: { raw: unknown; view: FindingView }) {
  const [showRaw, setShowRaw] = useState(false)
  const hasStructured =
    view.codeSection || view.description || view.severity || view.status || view.determination
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
      {view.codeSection ? (
        <div
          style={{
            fontWeight: 600,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-primary)',
          }}
        >
          {view.codeSection}
        </div>
      ) : null}
      {view.description ? (
        <div style={{ fontSize: 'var(--h-text-sm)', lineHeight: 1.4 }}>
          {view.description}
        </div>
      ) : null}
      {view.severity || view.status || view.determination ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {view.determination ? <Badge tone="accent">{view.determination}</Badge> : null}
          {view.severity ? <Badge tone="warning">{view.severity}</Badge> : null}
          {view.status ? <Badge tone="muted">{view.status}</Badge> : null}
        </div>
      ) : null}
      {!hasStructured ? (
        <pre
          style={{
            margin: 0,
            fontSize: 11,
            color: 'var(--h-text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {safeJson(raw)}
        </pre>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            style={rawToggleStyle}
          >
            {showRaw ? 'Hide raw' : 'Raw'}
          </button>
          {showRaw ? (
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                color: 'var(--h-text-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {safeJson(raw)}
            </pre>
          ) : null}
        </>
      )}
    </li>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'accent' | 'warning' | 'muted'
}) {
  const color =
    tone === 'accent'
      ? 'var(--h-accent)'
      : tone === 'warning'
        ? 'var(--h-warning)'
        : 'var(--h-text-muted)'
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color,
        border: `1px solid ${color}`,
        borderRadius: 'var(--h-radius-sm)',
        padding: '1px 6px',
      }}
    >
      {children}
    </span>
  )
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2)
  } catch {
    return String(x)
  }
}

function FindingsLibraryTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [submissions, setSubmissions] = useState<EngagementSubmissionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [findings, setFindings] = useState<unknown[]>([])
  const [loadingSubs, setLoadingSubs] = useState(false)
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSelectedId(null)
    setFindings([])
    if (!engagementId) {
      setSubmissions([])
      return
    }
    setLoadingSubs(true)
    setError(null)
    client
      .getSubmissions(engagementId)
      .then((rows) => {
        if (!cancelled) setSubmissions(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load submissions')
      })
      .finally(() => {
        if (!cancelled) setLoadingSubs(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  async function selectSubmission(id: string) {
    setSelectedId(id)
    setFindings([])
    setError(null)
    setLoadingFindings(true)
    try {
      const res = await client.getSubmissionFindings(id)
      setFindings(Array.isArray(res.findings) ? res.findings : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load findings')
    } finally {
      setLoadingFindings(false)
    }
  }

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
      <TileStatusBanner status="live" label="Findings Library" />

      {!engagementId ? (
        <span style={mutedText}>Select a case to view its findings.</span>
      ) : (
        <>
          <span style={labelStyle}>Submissions</span>
          {loadingSubs ? (
            <span style={mutedText}>Loading…</span>
          ) : error && submissions.length === 0 ? (
            <div role="alert" style={{ ...mutedText, color: 'var(--h-error)' }}>
              {error}
            </div>
          ) : submissions.length === 0 ? (
            <span style={mutedText}>No submissions for this case.</span>
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
              {submissions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void selectSubmission(s.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      borderRadius: 'var(--h-radius-sm)',
                      border:
                        selectedId === s.id
                          ? '1px solid var(--h-accent)'
                          : '1px solid var(--h-border-subtle)',
                      background:
                        selectedId === s.id ? 'var(--h-surface-3)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 'var(--h-text-sm)',
                      color: 'var(--h-text-primary)',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {s.id.slice(0, 8)}
                      {s.discipline ? ` · ${s.discipline}` : ''}
                    </div>
                    <div style={{ color: 'var(--h-text-muted)' }}>
                      {formatDate(s.submittedAt)} · {s.status} · {s.openFindingCount} open
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedId ? (
            <>
              <span style={labelStyle}>Findings</span>
              {loadingFindings ? (
                <span style={mutedText}>Loading findings…</span>
              ) : error ? (
                <div role="alert" style={{ ...mutedText, color: 'var(--h-error)' }}>
                  {error}
                </div>
              ) : findings.length === 0 ? (
                <span style={mutedText}>No findings on this submission.</span>
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
                  {findings.map((f, i) => (
                    <FindingCard key={toFindingView(f, i).key} raw={f} view={toFindingView(f, i)} />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

const rawToggleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '1px 8px',
  borderRadius: 'var(--h-radius-sm)',
  border: '1px solid var(--h-border-subtle)',
  background: 'transparent',
  color: 'var(--h-text-muted)',
  fontSize: 11,
  cursor: 'pointer',
}

export function FindingsLibraryTile() {
  return (
    <TileErrorBoundary label="Findings Library">
      <FindingsLibraryTileInner />
    </TileErrorBoundary>
  )
}
