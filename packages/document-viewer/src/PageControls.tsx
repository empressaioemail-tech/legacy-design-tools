import type { CSSProperties, ReactNode } from 'react'

export type PageControlsProps = {
  page: number
  pageCount: number
  onPage: (page: number) => void
  scale: number
  onScale: (scale: number) => void
}

const SCALE_MIN = 0.5
const SCALE_MAX = 4
const SCALE_STEP = 0.25

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--h-space-sm)',
  padding: 'var(--h-space-xs) var(--h-space-sm)',
  background: 'var(--h-surface-2)',
  border: '1px solid var(--h-border-subtle)',
  borderRadius: 'var(--h-radius-md)',
  fontFamily: 'var(--h-font-sans)',
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-primary)',
}

const labelStyle: CSSProperties = {
  color: 'var(--h-text-muted)',
  fontVariantNumeric: 'tabular-nums',
  minWidth: '4.5em',
  textAlign: 'center',
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    padding: 'var(--h-space-xs) var(--h-space-sm)',
    background: 'var(--h-surface-1)',
    color: disabled ? 'var(--h-text-muted)' : 'var(--h-text-primary)',
    border: '1px solid var(--h-border-strong)',
    borderRadius: 'var(--h-radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    font: 'inherit',
  }
}

function clampScale(value: number): number {
  return Math.min(Math.max(value, SCALE_MIN), SCALE_MAX)
}

export function PageControls(props: PageControlsProps): ReactNode {
  const { page, pageCount, onPage, scale, onScale } = props

  const atFirst = page <= 1
  const atLast = pageCount > 0 && page >= pageCount
  const canZoomOut = scale > SCALE_MIN
  const canZoomIn = scale < SCALE_MAX

  return (
    <div style={barStyle} role="toolbar" aria-label="Document controls">
      <button
        type="button"
        style={buttonStyle(atFirst)}
        disabled={atFirst}
        onClick={() => onPage(Math.max(1, page - 1))}
        aria-label="Previous page"
      >
        ‹ Prev
      </button>
      <span style={labelStyle}>
        {pageCount > 0 ? `${page} / ${pageCount}` : `${page}`}
      </span>
      <button
        type="button"
        style={buttonStyle(atLast)}
        disabled={atLast}
        onClick={() => onPage(pageCount > 0 ? Math.min(pageCount, page + 1) : page + 1)}
        aria-label="Next page"
      >
        Next ›
      </button>

      <span style={{ width: 'var(--h-space-md)' }} aria-hidden="true" />

      <button
        type="button"
        style={buttonStyle(!canZoomOut)}
        disabled={!canZoomOut}
        onClick={() => onScale(clampScale(scale - SCALE_STEP))}
        aria-label="Zoom out"
      >
        −
      </button>
      <span style={labelStyle}>{Math.round(scale * 100)}%</span>
      <button
        type="button"
        style={buttonStyle(!canZoomIn)}
        disabled={!canZoomIn}
        onClick={() => onScale(clampScale(scale + SCALE_STEP))}
        aria-label="Zoom in"
      >
        +
      </button>
    </div>
  )
}
