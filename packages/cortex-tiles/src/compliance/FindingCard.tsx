import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Finding, FindingSeverity } from './findingsHelpers'
import {
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  citationLabel,
  describeAdjudication,
  formatConfidence,
  resolveFindingConfidence,
  type OverrideDraft,
} from './findingsHelpers'
import { OverrideEditor } from './OverrideEditor'

const SEVERITY_COLORS: Record<FindingSeverity, { bg: string; fg: string }> = {
  blocker: { bg: 'var(--danger-dim)', fg: 'var(--danger-text)' },
  concern: { bg: 'var(--warning-dim)', fg: 'var(--warning-text)' },
  advisory: { bg: 'var(--info-dim)', fg: 'var(--info-text)' },
}

const badge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
}

const actionButton: CSSProperties = {
  padding: '5px 12px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid var(--border-subtle)',
}

export interface FindingCardProps {
  finding: Finding
  onAccept?: (findingId: string) => void
  onReject?: (findingId: string) => void
  onOverride?: (findingId: string, draft: OverrideDraft) => void
  busy?: boolean
  overrideError?: string | null
  highlighted?: boolean
  onSelect?: (findingId: string) => void
}

export function FindingCard({
  finding,
  onAccept,
  onReject,
  onOverride,
  busy,
  overrideError,
  highlighted,
  onSelect,
}: FindingCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const severity = SEVERITY_COLORS[finding.severity]
  const hasActions = Boolean(onAccept && onReject && onOverride)
  const adjudication = describeAdjudication(finding)
  const rootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (highlighted) {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [highlighted])

  return (
    <article
      ref={rootRef}
      data-testid="finding-card"
      onClick={onSelect ? () => onSelect(finding.id) : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-2, var(--bg-elevated))',
        cursor: onSelect ? 'pointer' : undefined,
        outline: highlighted ? '2px solid var(--accent, var(--info-text))' : undefined,
      }}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span data-testid="finding-severity" style={{ ...badge, background: severity.bg, color: severity.fg }}>
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{CATEGORY_LABELS[finding.category]}</span>
        <span
          data-testid="finding-status"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          {STATUS_LABELS[finding.status]}
        </span>
      </header>

      <p
        data-testid="finding-text"
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {finding.text}
      </p>

      <div
        data-testid="finding-citations"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'baseline',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Cites</span>
        {finding.citations.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>— no code citations on this finding</span>
        ) : (
          finding.citations.map((citation, i) => (
            <code
              key={`${citation.kind}-${i}`}
              data-testid="finding-citation"
              style={{
                fontSize: 11,
                fontFamily: '"IBM Plex Mono", monospace',
                padding: '2px 6px',
                borderRadius: 4,
                background: 'var(--info-dim)',
                color: 'var(--info-text)',
              }}
            >
              {citationLabel(citation)}
            </code>
          ))
        )}
      </div>

      <footer
        data-testid="finding-provenance"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        <span data-testid="finding-confidence">
          Confidence {formatConfidence(resolveFindingConfidence(finding))}
          {finding.lowConfidence ? ' · flagged low' : ''}
        </span>
        <span data-testid="finding-timestamp">Generated {new Date(finding.aiGeneratedAt).toLocaleString()}</span>
        {finding.elementRef ? <span data-testid="finding-element">Element {finding.elementRef}</span> : null}
        <span>{finding.aiGenerated ? 'AI-generated' : 'Reviewer-authored'}</span>
      </footer>

      {adjudication ? (
        <div
          data-testid="finding-adjudication"
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 8,
          }}
        >
          {adjudication}
          {finding.reviewerComment ? (
            <span
              data-testid="finding-reviewer-comment"
              style={{ display: 'block', marginTop: 2, color: 'var(--text-muted)' }}
            >
              "{finding.reviewerComment}"
            </span>
          ) : null}
        </div>
      ) : null}

      {overrideError ? (
        <div
          role="alert"
          data-testid="finding-override-error"
          style={{
            fontSize: 12,
            padding: '6px 8px',
            borderRadius: 4,
            background: 'var(--danger-dim)',
            color: 'var(--danger-text)',
          }}
        >
          {overrideError}
        </div>
      ) : null}

      {hasActions && isEditing ? (
        <div onClick={(e) => e.stopPropagation()}>
          <OverrideEditor
            finding={finding}
            busy={busy}
            onSubmit={(draft) => {
              onOverride?.(finding.id, draft)
              setIsEditing(false)
            }}
            onCancel={() => setIsEditing(false)}
          />
        </div>
      ) : hasActions ? (
        <div
          data-testid="finding-actions"
          style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            data-testid="finding-accept"
            onClick={() => onAccept?.(finding.id)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: 'var(--success-dim, var(--info-dim))',
              color: 'var(--success-text, var(--info-text))',
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Accept
          </button>
          <button
            type="button"
            data-testid="finding-edit"
            onClick={() => setIsEditing(true)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: 'transparent',
              color: 'var(--text-secondary)',
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Edit
          </button>
          <button
            type="button"
            data-testid="finding-reject"
            onClick={() => onReject?.(finding.id)}
            disabled={busy === true}
            style={{
              ...actionButton,
              background: 'var(--danger-dim)',
              color: 'var(--danger-text)',
              opacity: busy === true ? 0.5 : 1,
            }}
          >
            Reject
          </button>
        </div>
      ) : null}
    </article>
  )
}
