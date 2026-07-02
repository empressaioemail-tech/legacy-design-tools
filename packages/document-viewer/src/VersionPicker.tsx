import type { CSSProperties, ReactNode } from 'react'

export type Submission = {
  id: string
  label?: string
  submittedAt?: string
  status?: string
}

export type VersionPickerProps = {
  submissions: Submission[]
  activeId?: string
  onSelect: (id: string) => void
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--h-space-xs)',
  padding: 'var(--h-space-xs)',
  background: 'var(--h-surface-2)',
  border: '1px solid var(--h-border-subtle)',
  borderRadius: 'var(--h-radius-md)',
  fontFamily: 'var(--h-font-sans)',
  fontSize: 'var(--h-text-sm)',
}

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: 'var(--h-space-xs) var(--h-space-sm)',
    background: active ? 'var(--h-accent)' : 'var(--h-surface-1)',
    color: active ? 'var(--h-surface-0)' : 'var(--h-text-primary)',
    border: `1px solid ${active ? 'var(--h-accent)' : 'var(--h-border-strong)'}`,
    borderRadius: 'var(--h-radius-sm)',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: active ? 600 : 400,
  }
}

export function VersionPicker(props: VersionPickerProps): ReactNode {
  const { submissions, activeId, onSelect } = props

  if (submissions.length === 0) return null

  const currentId = submissions[submissions.length - 1]?.id

  return (
    <div style={barStyle} role="tablist" aria-label="Submission versions">
      {submissions.map((submission, index) => {
        const isCurrent = submission.id === currentId
        const isActive = activeId != null && activeId === submission.id
        const base = submission.label ?? `Submission ${index + 1}`
        const text = isCurrent ? `${base} (current)` : base
        return (
          <button
            key={submission.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            style={tabStyle(isActive)}
            onClick={() => onSelect(submission.id)}
            title={submission.status ?? submission.submittedAt ?? undefined}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
