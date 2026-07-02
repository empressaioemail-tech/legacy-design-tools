import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  label: string
  children: ReactNode
}

type State = {
  error: Error | null
}

/**
 * Per-tile error boundary. A crash inside one tile renders a compact fallback
 * (label + message + Retry) using the --h-* design tokens, so a single failing
 * tile never blanks the whole workspace grid.
 */
export class TileErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a console breadcrumb; the shell has no logging seam yet.
    // eslint-disable-next-line no-console
    console.error(`[TileErrorBoundary:${this.props.label}]`, error, info)
  }

  handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div
          role="alert"
          data-testid={`tile-error-${this.props.label}`}
          style={{
            padding: 'var(--h-space-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-sm)',
            color: 'var(--h-text-muted)',
            fontSize: 'var(--h-text-sm)',
          }}
        >
          <strong style={{ color: 'var(--h-error)' }}>
            {this.props.label} failed
          </strong>
          <span style={{ color: 'var(--h-text-muted)' }}>{error.message}</span>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              alignSelf: 'flex-start',
              padding: 'var(--h-space-xs) var(--h-space-sm)',
              borderRadius: 'var(--h-radius-sm)',
              border: '1px solid var(--h-border-subtle)',
              background: 'var(--h-surface-2)',
              color: 'var(--h-text-primary)',
              fontSize: 'var(--h-text-sm)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
