import { useState, type CSSProperties } from 'react'
import type { Finding } from './findingsHelpers'
import { CATEGORY_LABELS, CATEGORY_VALUES, SEVERITY_LABELS, SEVERITY_VALUES, type OverrideDraft } from './findingsHelpers'

const fieldLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
}

const controlBase: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-input, var(--bg-elevated))',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontFamily: 'inherit',
}

export function OverrideEditor({
  finding,
  busy,
  onSubmit,
  onCancel,
}: {
  finding: Finding
  busy?: boolean
  onSubmit: (draft: OverrideDraft) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(finding.text)
  const [severity, setSeverity] = useState(finding.severity)
  const [category, setCategory] = useState(finding.category)
  const [reviewerComment, setReviewerComment] = useState('')

  const canSubmit = text.trim() !== '' && reviewerComment.trim() !== '' && busy !== true

  return (
    <form
      data-testid="override-editor"
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSubmit) return
        onSubmit({
          text: text.trim(),
          severity,
          category,
          reviewerComment: reviewerComment.trim(),
        })
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        borderRadius: 6,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={fieldLabel}>Finding text</span>
        <textarea
          data-testid="override-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          style={{ ...controlBase, resize: 'vertical', lineHeight: 1.5 }}
        />
      </label>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLabel}>Severity</span>
          <select
            data-testid="override-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as any)}
            style={controlBase}
          >
            {SEVERITY_VALUES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLabel}>Category</span>
          <select
            data-testid="override-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as any)}
            style={controlBase}
          >
            {CATEGORY_VALUES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={fieldLabel}>Reason for the override (required)</span>
        <textarea
          data-testid="override-comment"
          value={reviewerComment}
          onChange={(e) => setReviewerComment(e.target.value)}
          rows={2}
          placeholder="Why is the engine's finding being changed?"
          style={{ ...controlBase, resize: 'vertical', lineHeight: 1.5 }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          data-testid="override-cancel"
          onClick={onCancel}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="override-submit"
          disabled={!canSubmit}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent, var(--info-text))',
            color: 'var(--accent-contrast, #fff)',
            fontSize: 12,
            fontWeight: 600,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {busy === true ? 'Saving…' : 'Save override'}
        </button>
      </div>
    </form>
  )
}
