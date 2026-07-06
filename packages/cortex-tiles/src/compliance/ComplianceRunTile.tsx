import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useEngagement } from '@hauska/tile-shell'
import { TileStatusBanner } from '@hauska/tile-shell'
import { useAnnotationSelection, useDocumentViewerNavigation } from '@hauska/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { FindingCard } from './FindingCard'
import { JurisdictionBar } from './JurisdictionBar'
import { sortFindings, type Finding, type OverrideDraft } from './findingsHelpers'
import type { JurisdictionSummary } from './jurisdictionHelpers'

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
}

const selectStyle: CSSProperties = {
  minWidth: 180,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-input, var(--bg-elevated))',
  color: 'var(--text-primary)',
  fontSize: 13,
}

type EngagementSubmissionSummary = {
  id: string
  submittedAt: string
  jurisdiction: string | null
  status: string
}

function ComplianceRunTileInner() {
  const { engagementId, engagement } = useEngagement()
  const client = useCortexClient()
  const { selectedFindingId } = useAnnotationSelection()
  const { requestPage, findingPages } = useDocumentViewerNavigation()
  const [submissionId, setSubmissionId] = useState('')

  const [submissions, setSubmissions] = useState<EngagementSubmissionSummary[]>([])
  const [jurisdictions, setJurisdictions] = useState<JurisdictionSummary[]>([])
  const [jurisdictionsLoading, setJurisdictionsLoading] = useState(false)
  const [statusState, setStatusState] = useState<string | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [runMutationPending, setRunMutationPending] = useState(false)
  const [acceptMutation, setAcceptMutation] = useState<{ pending: boolean; findingId: string | null }>({
    pending: false,
    findingId: null,
  })
  const [rejectMutation, setRejectMutation] = useState<{ pending: boolean; findingId: string | null }>({
    pending: false,
    findingId: null,
  })
  const [overrideMutation, setOverrideMutation] = useState<{
    pending: boolean
    findingId: string | null
    error: string | null
  }>({ pending: false, findingId: null, error: null })

  useEffect(() => {
    if (!engagementId) return
    let cancelled = false
    client
      .getSubmissions(engagementId)
      .then((subs) => {
        if (!cancelled) setSubmissions(subs as EngagementSubmissionSummary[])
      })
      .catch(() => {
        if (!cancelled) setSubmissions([])
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  useEffect(() => {
    let cancelled = false
    setJurisdictionsLoading(true)
    client
      .fetch<{ jurisdictions: JurisdictionSummary[] }>('/api/codes/jurisdictions')
      .then((res) => {
        if (!cancelled) setJurisdictions(res.jurisdictions ?? [])
      })
      .catch(() => {
        if (!cancelled) setJurisdictions([])
      })
      .finally(() => {
        if (!cancelled) setJurisdictionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const selectedSubmission = submissions.find((s) => s.id === submissionId) ?? null

  useEffect(() => {
    if (!submissionId) {
      setStatusState(null)
      return
    }
    let cancelled = false
    const poll = () => {
      client
        .getSubmissionFindingsStatus(submissionId)
        .then((status) => {
          if (cancelled) return
          setStatusState(status.state)
          if (status.state === 'pending') {
            setTimeout(poll, 2000)
          }
        })
        .catch(() => {
          if (!cancelled) setStatusState(null)
        })
    }
    poll()
    return () => {
      cancelled = true
    }
  }, [submissionId, client])

  const isGenerating = statusState === 'pending'

  useEffect(() => {
    if (!submissionId) {
      setFindings([])
      return
    }
    let cancelled = false
    client
      .getSubmissionFindings(submissionId)
      .then((res) => {
        if (!cancelled) setFindings(sortFindings((res.findings as Finding[]) ?? []))
      })
      .catch(() => {
        if (!cancelled) setFindings([])
      })
    return () => {
      cancelled = true
    }
  }, [submissionId, client])

  const lastStateRef = useRef<string | null>(null)
  useEffect(() => {
    const current = statusState ?? null
    if (lastStateRef.current === 'pending' && (current === 'completed' || current === 'failed')) {
      client
        .getSubmissionFindings(submissionId)
        .then((res) => setFindings(sortFindings((res.findings as Finding[]) ?? [])))
        .catch(() => setFindings([]))
    }
    lastStateRef.current = current
  }, [statusState, submissionId, client])

  async function runReview() {
    if (!engagementId || !submissionId) return
    setRunMutationPending(true)
    try {
      await client.runCompliancePass(engagementId, submissionId)
      const status = await client.getSubmissionFindingsStatus(submissionId)
      setStatusState(status.state)
    } catch {
      // error handling
    } finally {
      setRunMutationPending(false)
    }
  }

  async function acceptFinding(findingId: string) {
    if (!engagementId) return
    setAcceptMutation({ pending: true, findingId })
    try {
      await client.fetch(`/api/findings/${findingId}/accept`, { method: 'POST', body: '{}' })
      const res = await client.getSubmissionFindings(submissionId)
      setFindings(sortFindings((res.findings as Finding[]) ?? []))
    } catch {
      // error handling
    } finally {
      setAcceptMutation({ pending: false, findingId: null })
    }
  }

  async function rejectFinding(findingId: string) {
    if (!engagementId) return
    setRejectMutation({ pending: true, findingId })
    try {
      await client.fetch(`/api/findings/${findingId}/reject`, { method: 'POST', body: '{}' })
      const res = await client.getSubmissionFindings(submissionId)
      setFindings(sortFindings((res.findings as Finding[]) ?? []))
    } catch {
      // error handling
    } finally {
      setRejectMutation({ pending: false, findingId: null })
    }
  }

  async function overrideFinding(findingId: string, draft: OverrideDraft) {
    if (!engagementId) return
    setOverrideMutation({ pending: true, findingId, error: null })
    try {
      await client.fetch(`/api/findings/${findingId}/override`, {
        method: 'POST',
        body: JSON.stringify({
          text: draft.text,
          severity: draft.severity,
          category: draft.category,
          reviewerComment: draft.reviewerComment,
        }),
      })
      const res = await client.getSubmissionFindings(submissionId)
      setFindings(sortFindings((res.findings as Finding[]) ?? []))
      setOverrideMutation({ pending: false, findingId: null, error: null })
    } catch (err: unknown) {
      setOverrideMutation({
        pending: false,
        findingId,
        error: err instanceof Error ? err.message : 'Could not save the override. Try again.',
      })
    }
  }

  function findingBusy(findingId: string): boolean {
    return (
      (acceptMutation.pending && acceptMutation.findingId === findingId) ||
      (rejectMutation.pending && rejectMutation.findingId === findingId) ||
      (overrideMutation.pending && overrideMutation.findingId === findingId)
    )
  }

  if (!engagementId) {
    return (
      <div style={{ padding: 12 }}>
        <TileStatusBanner status="live" label="Compliance Run" />
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Select a case from Intake & Queue to run compliance.
        </p>
      </div>
    )
  }

  return (
    <div
      style={{
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Compliance Run" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Submission</span>
          <select
            data-testid="submission-select"
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            style={selectStyle}
          >
            <option value="">Select submission</option>
            {submissions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.submittedAt).toLocaleDateString()} · {s.status}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-testid="run-review-button"
          disabled={!submissionId || isGenerating || runMutationPending}
          onClick={() => runReview()}
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent, var(--info-text))',
            color: 'var(--accent-contrast, #fff)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            opacity: !submissionId || isGenerating ? 0.5 : 1,
          }}
        >
          {isGenerating || runMutationPending ? 'Running…' : 'Run review'}
        </button>
      </div>

      <JurisdictionBar
        engagement={engagement}
        submission={selectedSubmission}
        jurisdictions={jurisdictions}
        corpusLoading={jurisdictionsLoading}
      />

      {findings.length > 0 ? (
        <div data-testid="findings-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              highlighted={finding.id === selectedFindingId}
              onSelect={(id) => {
                const p = findingPages[id]
                if (typeof p === 'number') requestPage(p, id)
              }}
              onAccept={(id) => acceptFinding(id)}
              onReject={(id) => rejectFinding(id)}
              onOverride={(id, draft) => overrideFinding(id, draft)}
              busy={findingBusy(finding.id)}
              overrideError={
                overrideMutation.findingId === finding.id ? overrideMutation.error : null
              }
            />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {submissionId ? (isGenerating ? 'Engine running…' : 'No findings yet.') : 'Pick a submission.'}
        </p>
      )}
    </div>
  )
}

export function ComplianceRunTile() {
  return (
    <TileErrorBoundary label="Compliance Run">
      <ComplianceRunTileInner />
    </TileErrorBoundary>
  )
}
