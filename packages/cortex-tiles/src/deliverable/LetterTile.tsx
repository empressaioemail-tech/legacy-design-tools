import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@hauska/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

// Helper to determine if findings are letter-eligible
function isLetterEligible(finding: { status: string; revisionOf: string | null }): boolean {
  if (finding.status === 'accepted') return true
  if (finding.status === 'overridden' && finding.revisionOf !== null) return true
  return false
}

function letterEligibleFindings(findings: unknown[]): unknown[] {
  return findings.filter((f): boolean => {
    if (typeof f !== 'object' || f === null) return false
    const finding = f as { status?: string; revisionOf?: string | null; severity?: string; aiGeneratedAt?: string }
    return isLetterEligible({ status: finding.status ?? '', revisionOf: finding.revisionOf ?? null })
  })
}

function LetterTileInner() {
  const { engagementId } = useEngagement()
  const client = useCortexClient()
  const [draft, setDraft] = useState('')
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [loadingDraft, setLoadingDraft] = useState(false)
  const [loadingSubmissions, setLoadingSubmissions] = useState(false)
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyOk, setCopyOk] = useState(false)
  const [latestSubmissionId, setLatestSubmissionId] = useState<string | null>(null)
  const [findings, setFindings] = useState<unknown[]>([])

  // Load letter draft
  useEffect(() => {
    if (!engagementId) {
      setDraft('')
      setGeneratedAt(null)
      return
    }
    let cancelled = false
    setLoadingDraft(true)
    client
      .getLetter(engagementId)
      .then((res) => {
        if (cancelled) return
        setDraft(res.draft ?? '')
        setGeneratedAt(res.generatedAt)
      })
      .catch(() => {
        if (!cancelled) {
          setDraft('')
          setGeneratedAt(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDraft(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  // Load submissions to get latest
  useEffect(() => {
    if (!engagementId) {
      setLatestSubmissionId(null)
      return
    }
    let cancelled = false
    setLoadingSubmissions(true)
    client
      .getSubmissions(engagementId)
      .then((submissions) => {
        if (cancelled) return
        setLatestSubmissionId(submissions.length > 0 ? submissions[0].id : null)
      })
      .catch(() => {
        if (!cancelled) setLatestSubmissionId(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingSubmissions(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  // Load findings for latest submission
  useEffect(() => {
    if (!latestSubmissionId) {
      setFindings([])
      return
    }
    let cancelled = false
    setLoadingFindings(true)
    client
      .getSubmissionFindings(latestSubmissionId)
      .then((res) => {
        if (cancelled) return
        setFindings(Array.isArray(res.findings) ? res.findings : [])
      })
      .catch(() => {
        if (!cancelled) setFindings([])
      })
      .finally(() => {
        if (!cancelled) setLoadingFindings(false)
      })
    return () => {
      cancelled = true
    }
  }, [latestSubmissionId, client])

  const letterEligible = letterEligibleFindings(findings)

  async function handleGenerate() {
    if (!engagementId) return
    setError(null)
    setGenerating(true)
    try {
      const res = await client.generateLetter(engagementId)
      setDraft(res.draft ?? '')
      setGeneratedAt(res.generatedAt ?? null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not generate letter.')
    } finally {
      setGenerating(false)
    }
  }

  async function handleCopy() {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(draft)
      setCopyOk(true)
      window.setTimeout(() => setCopyOk(false), 2000)
    } catch {
      setError('Copy failed.')
    }
  }

  function handleDownload() {
    if (!draft) return
    const blob = new Blob([draft], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'comment-letter.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const textareaStyle: CSSProperties = {
    flex: 1,
    minHeight: 160,
    padding: 10,
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-input, var(--bg-elevated))',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontFamily: 'inherit',
    resize: 'vertical',
  }

  const isLoading = loadingDraft || loadingSubmissions || loadingFindings

  return (
    <div
      style={{
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Deliverable Letter" />
      {!engagementId ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
          Select a case from Intake & Queue to draft a letter.
        </p>
      ) : isLoading ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>Loading draft…</p>
      ) : draft ? (
        <>
          <textarea
            data-testid="letter-draft-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={textareaStyle}
          />
          {generatedAt ? (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Generated {new Date(generatedAt).toLocaleString()}
            </span>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="letter-regenerate"
              disabled={generating || letterEligible.length === 0}
              onClick={() => void handleGenerate()}
              style={buttonStyle(generating)}
            >
              {generating ? 'Generating…' : 'Regenerate'}
            </button>
            <button
              type="button"
              data-testid="letter-copy"
              onClick={() => void handleCopy()}
              style={buttonStyle(false)}
            >
              {copyOk ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              data-testid="letter-download"
              onClick={handleDownload}
              style={buttonStyle(false)}
            >
              Download .txt
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
            {letterEligible.length} finding{letterEligible.length === 1 ? '' : 's'} ready
          </p>
          <button
            type="button"
            data-testid="draft-comment-letter-button"
            disabled={letterEligible.length === 0 || generating}
            onClick={() => void handleGenerate()}
            style={buttonStyle(generating)}
          >
            {generating ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="letter-spinner" aria-hidden />
                Generating…
              </span>
            ) : (
              'Draft comment letter'
            )}
          </button>
        </>
      )}
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: 'var(--danger-text)' }}>
          {error}
        </div>
      ) : null}
    </div>
  )
}

export function LetterTile() {
  return (
    <TileErrorBoundary label="Deliverable Letter">
      <LetterTileInner />
    </TileErrorBoundary>
  )
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent, var(--info-text))',
    color: 'var(--accent-contrast, #fff)',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }
}
