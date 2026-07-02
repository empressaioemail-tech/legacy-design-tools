import type { CSSProperties, ReactNode } from 'react'

/**
 * The canonical markup-tool union for the document viewer.
 *
 * This is the UI-facing toolbar vocabulary (what a reviewer picks). It maps
 * onto the persisted {@link import('./types').AnnotationKind} at draw-finalize
 * time inside `AnnotationLayer` (`pen -> redline`, the rest are identity).
 *
 * Kept here (single source of truth) so `PDFViewer` and `AnnotationLayer`
 * import the same literal set rather than re-declaring it. "No active tool"
 * is modelled as `MarkupTool | null` at the prop level, not as a `'none'`
 * member, so the drawing seam can key purely on truthiness.
 */
export type MarkupTool = 'pen' | 'shape' | 'text' | 'stamp'

export type MarkupToolbarProps = {
  active: MarkupTool | null
  onSelect: (tool: MarkupTool | null) => void
}

const TOOLS: { tool: MarkupTool; label: string; icon: string }[] = [
  { tool: 'pen', label: 'Redline', icon: '✎' },
  { tool: 'shape', label: 'Shape', icon: '▭' },
  { tool: 'text', label: 'Text', icon: 'T' },
  { tool: 'stamp', label: 'Stamp', icon: '✔' },
]

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

function toolStyle(isActive: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--h-space-xs)',
    padding: 'var(--h-space-xs) var(--h-space-sm)',
    background: isActive ? 'var(--h-accent)' : 'var(--h-surface-1)',
    color: isActive ? 'var(--h-surface-0)' : 'var(--h-text-primary)',
    border: `1px solid ${isActive ? 'var(--h-accent)' : 'var(--h-border-strong)'}`,
    borderRadius: 'var(--h-radius-sm)',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: isActive ? 600 : 400,
  }
}

export function MarkupToolbar(props: MarkupToolbarProps): ReactNode {
  const { active, onSelect } = props

  return (
    <div style={barStyle} role="toolbar" aria-label="Markup tools">
      {TOOLS.map(({ tool, label, icon }) => {
        const isActive = active === tool
        return (
          <button
            key={tool}
            type="button"
            aria-pressed={isActive}
            style={toolStyle(isActive)}
            // Toggle: clicking the active tool clears the selection.
            onClick={() => onSelect(isActive ? null : tool)}
            title={label}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
