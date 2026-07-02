import { type CSSProperties } from 'react'
import { TileStatusBanner } from '@hauska/tile-shell'

export const runButtonStyle = (disabled: boolean): CSSProperties => ({
  padding: 'var(--h-space-sm) 14px',
  borderRadius: 'var(--h-radius-sm)',
  border: 'none',
  background: 'var(--h-accent)',
  color: '#fff',
  fontSize: 'var(--h-text-sm)',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  alignSelf: 'flex-start',
})

/**
 * Shared presentational shell for the run-and-show-JSON property-intel tiles
 * (Property Brief, Hazard Profile, Encumbrances). Kept dependency-free so all
 * three can compose it inside the package.
 */
export function ReportTileShell(props: {
  label: string
  engagementId: string | null
  busy: boolean
  error: string | null
  onRun: () => void
  result: unknown
  emptyHint: string
  runLabel?: string
  quotaBanner?: string | null
}) {
  const {
    label,
    engagementId,
    busy,
    error,
    onRun,
    result,
    emptyHint,
    runLabel = 'Run report',
    quotaBanner,
  } = props

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label={label} />
      {!engagementId ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
          }}
        >
          Select a case first.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onRun}
            style={runButtonStyle(!engagementId || busy)}
          >
            {busy ? 'Running…' : runLabel}
          </button>
          {quotaBanner ? (
            <div
              role="status"
              style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-warning)' }}
            >
              {quotaBanner}
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}
            >
              {error}
            </div>
          ) : null}
          {result ? (
            <details open style={{ fontSize: 'var(--h-text-sm)' }}>
              <summary style={{ cursor: 'pointer', marginBottom: 6 }}>
                Result (collapsible JSON)
              </summary>
              <pre
                style={{
                  margin: 0,
                  padding: 'var(--h-space-sm)',
                  background: 'var(--h-surface-2)',
                  borderRadius: 'var(--h-radius-md)',
                  overflow: 'auto',
                  maxHeight: 280,
                  fontSize: 11,
                }}
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          ) : (
            <p
              style={{
                margin: 0,
                fontSize: 'var(--h-text-sm)',
                color: 'var(--h-text-muted)',
              }}
            >
              {emptyHint}
            </p>
          )}
        </>
      )}
    </div>
  )
}
