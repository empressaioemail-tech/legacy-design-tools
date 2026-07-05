import { useCallback, useEffect, useRef, useState } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import type {
  EngagementDocument,
  DataroomAtomChip,
  AssertedConfidence,
} from '@empressaio/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

// ─── Access-policy chip color (permission-ready display, not editable) ───────
function accessPolicyStyle(policy: string): { bg: string; fg: string; label: string } {
  switch (policy) {
    case 'tenant-private':
      return { bg: 'var(--h-surface-3, #eef)', fg: 'var(--h-text-primary)', label: 'tenant-private' }
    case 'tenant-shared':
      return { bg: 'var(--h-surface-3, #eef)', fg: 'var(--h-text-primary)', label: 'tenant-shared' }
    case 'platform-internal':
      return { bg: 'var(--h-surface-2)', fg: 'var(--h-text-muted)', label: 'platform-internal' }
    case 'public-free':
      return { bg: '#e6f5ea', fg: '#186a3b', label: 'public-free' }
    case 'public-paid':
      return { bg: '#fdeecf', fg: '#8a5b00', label: 'public-paid' }
    default:
      return { bg: 'var(--h-surface-2)', fg: 'var(--h-text-muted)', label: policy }
  }
}

// Render the asserted widthed confidence as value ± half-width, never bare.
function confidenceLabel(c: AssertedConfidence): string {
  const pct = Math.round(c.value * 100)
  const half = Math.round((c.intervalWidth / 2) * 100)
  const kind = c.kind === 'calibrated' ? 'calibrated' : 'asserted'
  return `${pct}% ±${half} (${kind}, n=${c.n})`
}

function shortCid(cid: string): string {
  // Show a readable citation handle for the source document.
  if (cid.length <= 20) return cid
  return `${cid.slice(0, 12)}…${cid.slice(-6)}`
}

// ─── One cited, confidence-graded atom chip ──────────────────────────────────
function AtomChip({ atom }: { atom: DataroomAtomChip }) {
  const ap = accessPolicyStyle(atom.accessPolicy)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 'var(--h-space-xs, 6px) var(--h-space-sm, 8px)',
        borderRadius: 'var(--h-radius-sm, 6px)',
        border: '1px solid var(--h-border-subtle, #ddd)',
        background: 'var(--h-surface-2, #fafafa)',
        fontSize: 'var(--h-text-xs, 11px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--h-text-sm, 12px)', color: 'var(--h-text-primary)' }}>
          {atom.entityType}
        </strong>
        <span
          title={`Access policy: ${atom.accessPolicy} (resolved by the engine; not editable here)`}
          style={{
            padding: '1px 6px',
            borderRadius: 999,
            background: ap.bg,
            color: ap.fg,
            fontWeight: 600,
          }}
        >
          {ap.label}
        </span>
        <span style={{ color: 'var(--h-text-muted)' }}>{atom.verificationStatus}</span>
      </div>
      <div style={{ color: 'var(--h-text-muted)' }}>
        confidence {confidenceLabel(atom.confidence)}
      </div>
      <div style={{ color: 'var(--h-text-muted)', wordBreak: 'break-all' }}>
        <span style={{ fontWeight: 600 }}>cite:</span>{' '}
        <span
          title={`source document ${atom.sourceDocumentCid} (${atom.storageRelation})`}
        >
          {shortCid(atom.sourceDocumentCid)}
        </span>{' '}
        <span style={{ opacity: 0.7 }}>({atom.storageRelation})</span>
      </div>
      <div style={{ color: 'var(--h-text-muted)', opacity: 0.7, wordBreak: 'break-all' }}>
        {atom.atomDid}
      </div>
    </div>
  )
}

function DataroomTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()

  const [documents, setDocuments] = useState<EngagementDocument[]>([])
  const [atomsByDocument, setAtomsByDocument] = useState<
    Record<string, DataroomAtomChip[]>
  >({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [uploading, setUploading] = useState(false)
  const [ingestingId, setIngestingId] = useState<string | null>(null)
  const [ingestNote, setIngestNote] = useState<Record<string, string>>({})
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const hydrate = useCallback(
    async (id: string) => {
      const [docsRes, atomsRes] = await Promise.all([
        client.listEngagementDocuments(id),
        client.getDataroomAtoms(id),
      ])
      setDocuments(docsRes.documents)
      setAtomsByDocument(atomsRes.atomsByDocument)
    },
    [client],
  )

  useEffect(() => {
    if (!engagementId) {
      setDocuments([])
      setAtomsByDocument({})
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    hydrate(engagementId)
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dataroom')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, hydrate])

  async function onUpload(file: File) {
    if (!engagementId) return
    setUploading(true)
    setError(null)
    try {
      const { uploadUrl, objectPath } = await client.requestDocumentUploadUrl(
        engagementId,
        { filename: file.name, contentType: file.type || 'application/octet-stream' },
      )
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`)
      await client.completeDocumentUpload(engagementId, {
        objectPath,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      })
      await hydrate(engagementId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function onIngest(documentId: string) {
    if (!engagementId) return
    setIngestingId(documentId)
    setIngestNote((n) => ({ ...n, [documentId]: '' }))
    try {
      const result = await client.ingestDataroomDocument(engagementId, documentId)
      setAtomsByDocument((prev) => ({ ...prev, [documentId]: result.atoms }))
      if (result.status === 'degraded') {
        setIngestNote((n) => ({
          ...n,
          [documentId]: `Degraded: ${result.reason ?? 'document not fully readable'} — blob pinned.`,
        }))
      } else if (result.atoms.length === 0) {
        setIngestNote((n) => ({
          ...n,
          [documentId]: 'No atoms extracted from this document.',
        }))
      } else {
        const cls = result.classification
        setIngestNote((n) => ({
          ...n,
          [documentId]: cls?.documentType
            ? `Classified as ${cls.documentType} — ${result.atoms.length} atom(s).`
            : `${result.atoms.length} atom(s) extracted.`,
        }))
      }
    } catch (err: unknown) {
      setIngestNote((n) => ({
        ...n,
        [documentId]: err instanceof Error ? err.message : 'Ingest failed',
      }))
    } finally {
      setIngestingId(null)
    }
  }

  return (
    <div
      style={{
        padding: 'var(--h-space-sm, 8px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm, 8px)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Dataroom / Files" />

      {!engagementId ? (
        <p style={mutedText}>Select a case first.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              style={primaryBtn(uploading)}
            >
              {uploading ? 'Uploading…' : 'Upload file'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              data-testid="dataroom-file-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUpload(f)
              }}
            />
            <span style={mutedText}>
              {documents.length} file{documents.length === 1 ? '' : 's'} in this dataroom
            </span>
          </div>

          {loading ? <p style={mutedText}>Loading…</p> : null}
          {error ? (
            <div role="alert" style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error, #b00)' }}>
              {error}
            </div>
          ) : null}

          {!loading && documents.length === 0 ? (
            <p style={mutedText}>No files yet. Upload a survey, title, or plat PDF to extract atoms.</p>
          ) : null}

          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--h-space-sm, 8px)' }}>
            {documents.map((doc) => {
              const atoms = atomsByDocument[doc.id] ?? []
              const busy = ingestingId === doc.id
              return (
                <li
                  key={doc.id}
                  style={{
                    border: '1px solid var(--h-border-subtle, #ddd)',
                    borderRadius: 'var(--h-radius-sm, 6px)',
                    padding: 'var(--h-space-sm, 8px)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    background: 'var(--h-surface-1, #fff)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {doc.url ? (
                      <a
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontWeight: 600, color: 'var(--h-accent, #2255cc)', fontSize: 'var(--h-text-sm)' }}
                      >
                        {doc.title}
                      </a>
                    ) : (
                      <strong style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-text-primary)' }}>
                        {doc.title}
                      </strong>
                    )}
                    <span style={mutedText}>{doc.documentType}</span>
                    <button
                      type="button"
                      disabled={busy}
                      data-testid={`dataroom-ingest-${doc.id}`}
                      onClick={() => void onIngest(doc.id)}
                      style={secondaryBtn(busy)}
                    >
                      {busy ? 'Extracting…' : atoms.length > 0 ? 'Re-extract atoms' : 'Extract atoms'}
                    </button>
                  </div>

                  {ingestNote[doc.id] ? (
                    <div style={{ ...mutedText, fontStyle: 'italic' }}>{ingestNote[doc.id]}</div>
                  ) : null}

                  {atoms.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                        Extracted atoms
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {atoms.map((a) => (
                          <AtomChip key={a.atomDid} atom={a} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

const mutedText = {
  margin: 0,
  fontSize: 'var(--h-text-sm, 12px)',
  color: 'var(--h-text-muted, #777)',
} as const

function primaryBtn(disabled: boolean) {
  return {
    padding: 'var(--h-space-sm, 8px) 14px',
    borderRadius: 'var(--h-radius-sm, 6px)',
    border: 'none',
    background: 'var(--h-accent, #2255cc)',
    color: '#fff',
    fontSize: 'var(--h-text-sm, 12px)',
    fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  } as const
}

function secondaryBtn(disabled: boolean) {
  return {
    padding: '4px 10px',
    borderRadius: 'var(--h-radius-sm, 6px)',
    border: '1px solid var(--h-border-subtle, #ccc)',
    background: 'transparent',
    color: 'var(--h-text-primary)',
    fontSize: 'var(--h-text-xs, 11px)',
    cursor: disabled ? 'wait' : 'pointer',
    marginLeft: 'auto',
    opacity: disabled ? 0.7 : 1,
  } as const
}

export function DataroomTile() {
  return (
    <TileErrorBoundary label="Dataroom / Files">
      <DataroomTileInner />
    </TileErrorBoundary>
  )
}
