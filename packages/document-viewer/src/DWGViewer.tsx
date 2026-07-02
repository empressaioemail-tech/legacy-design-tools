import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

// The Autodesk Platform Services (APS) Viewer SDK is an external, untyped global
// injected by the CDN script we load at runtime. This is the ONE justified `any`
// in this package: there is no first-party type package for the v7 Viewer global,
// and shipping our own full ambient typing would be speculative. We contain it to
// this single module-level `Window.Autodesk` declaration; every other value in
// this file is strictly typed.
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external untyped APS Viewer SDK global
    Autodesk?: any
  }
}

export type DWGViewerProps = {
  /** Model Derivative URN of the translated DWG/RVT/IFC document. */
  urn?: string
  /**
   * Returns a short-lived APS viewer token. Wired to the BFF
   * `GET /engagements/:id/aps-viewer-token` route. Absence (or a missing urn)
   * puts the component into its named not-configured fallback state.
   */
  getViewerToken?: () => Promise<{ accessToken: string; expiresIn: number }>
  /** Fired once the default geometry finishes loading in the viewer. */
  onReady?: () => void
  /** Optional caller-supplied fallback; overrides the built-in notice. */
  fallback?: ReactNode
}

const APS_VIEWER_VERSION = '7.*'
const APS_VIEWER_BASE = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${APS_VIEWER_VERSION}`
const APS_VIEWER_SCRIPT = `${APS_VIEWER_BASE}/viewer3D.min.js`
const APS_VIEWER_CSS = `${APS_VIEWER_BASE}/style.min.css`

const containerStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  background: 'var(--h-surface-1)',
  borderRadius: 'var(--h-radius-md)',
  border: '1px solid var(--h-border-subtle)',
  overflow: 'hidden',
}

const noticeStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--h-space-sm)',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  padding: 'var(--h-space-lg)',
  fontFamily: 'var(--h-font-sans)',
  fontSize: 'var(--h-text-sm)',
  lineHeight: 1.5,
  color: 'var(--h-text-muted)',
  background: 'var(--h-surface-1)',
  borderRadius: 'var(--h-radius-md)',
  border: '1px solid var(--h-warning)',
}

const noticeTitleStyle: CSSProperties = {
  color: 'var(--h-warning)',
  fontWeight: 600,
  fontSize: 'var(--h-text-md)',
}

/**
 * Load the APS Viewer SDK (script + stylesheet) from the CDN once. Resolves when
 * `window.Autodesk` is present. Rejects if the script fails to load.
 */
function loadApsViewerSdk(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window is not available (SSR context)'))
  }
  if (window.Autodesk) {
    return Promise.resolve()
  }

  // Stylesheet (idempotent — only append once).
  if (!document.querySelector(`link[data-aps-viewer-css]`)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = APS_VIEWER_CSS
    link.setAttribute('data-aps-viewer-css', 'true')
    document.head.appendChild(link)
  }

  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-aps-viewer-script]',
    )
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () =>
        reject(new Error('APS Viewer SDK script failed to load')),
      )
      // If it already finished loading before we attached, window.Autodesk is set.
      if (window.Autodesk) resolve()
      return
    }
    const script = document.createElement('script')
    script.src = APS_VIEWER_SCRIPT
    script.async = true
    script.setAttribute('data-aps-viewer-script', 'true')
    script.addEventListener('load', () => {
      if (window.Autodesk) resolve()
      else reject(new Error('APS Viewer SDK loaded but window.Autodesk is absent'))
    })
    script.addEventListener('error', () =>
      reject(new Error('APS Viewer SDK script failed to load')),
    )
    document.head.appendChild(script)
  })
}

export function DWGViewer(props: DWGViewerProps): ReactNode {
  const { urn, getViewerToken, onReady, fallback } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  // `error` holds a named reason string when the APS path is unavailable.
  const [error, setError] = useState<string | null>(null)

  // Not-configured path (AUTH-001): no urn or no token supplier means APS is not
  // wired in this environment. This is the expected steady state today.
  const notConfigured = !urn || !getViewerToken

  useEffect(() => {
    if (notConfigured) return

    let cancelled = false
    // The APS Viewer instance, kept for teardown. Loosely typed via the SDK global.
    let viewer: { finish?: () => void } | null = null

    const run = async (): Promise<void> => {
      try {
        await loadApsViewerSdk()
        if (cancelled) return

        const Autodesk = window.Autodesk
        if (!Autodesk) {
          throw new Error('APS Viewer SDK unavailable after load')
        }

        // Fetch the initial token up front so a token failure (e.g. a 501
        // aps_not_configured or a 403 AUTH-001 from the BFF) surfaces as the
        // named fallback rather than an opaque viewer error.
        // getViewerToken is guaranteed present here (notConfigured guard above).
        const first = await getViewerToken!()
        if (cancelled) return

        await new Promise<void>((resolveInit) => {
          Autodesk.Viewing.Initializer(
            {
              env: 'AutodeskProduction',
              getAccessToken: (
                onToken: (token: string, expires: number) => void,
              ) => {
                // Re-fetch on the SDK's cadence so long sessions stay authorized.
                void getViewerToken!()
                  .then(({ accessToken, expiresIn }) => {
                    onToken(accessToken, expiresIn)
                  })
                  .catch((err: unknown) => {
                    if (cancelled) return
                    const reason =
                      err instanceof Error ? err.message : String(err)
                    setError(`APS viewer token refresh failed: ${reason}`)
                  })
              },
            },
            () => resolveInit(),
          )
        })
        if (cancelled) return

        const container = containerRef.current
        if (!container) {
          throw new Error('viewer container not mounted')
        }

        viewer = new Autodesk.Viewing.GuiViewer3D(container)
        const startCode: number = (viewer as { start: () => number }).start()
        if (startCode > 0) {
          throw new Error(`APS viewer failed to start (code ${startCode})`)
        }

        Autodesk.Viewing.Document.load(
          `urn:${urn}`,
          (doc: {
            getRoot: () => { getDefaultGeometry: () => unknown }
          }) => {
            if (cancelled) return
            const defaultModel = doc.getRoot().getDefaultGeometry()
            const loadPromise = (
              viewer as {
                loadDocumentNode: (
                  d: unknown,
                  m: unknown,
                ) => Promise<unknown>
              }
            ).loadDocumentNode(doc, defaultModel)
            void Promise.resolve(loadPromise)
              .then(() => {
                if (cancelled) return
                if (onReady) onReady()
              })
              .catch((err: unknown) => {
                if (cancelled) return
                const reason =
                  err instanceof Error ? err.message : String(err)
                setError(`APS model failed to load: ${reason}`)
              })
          },
          (errorCode: number, errorMsg: string) => {
            if (cancelled) return
            setError(
              `APS document failed to load: ${errorMsg} (code ${errorCode})`,
            )
          },
        )
      } catch (err: unknown) {
        if (cancelled) return
        const reason = err instanceof Error ? err.message : String(err)
        setError(`APS viewer unavailable: ${reason}`)
      }
    }

    void run()

    return () => {
      cancelled = true
      // Tear down the viewer so we never leak a WebGL context across remounts.
      if (viewer && typeof viewer.finish === 'function') {
        try {
          viewer.finish()
        } catch {
          // Best-effort teardown; a failing finish() must never throw upward.
        }
      }
    }
  }, [notConfigured, urn, getViewerToken, onReady])

  // Named fallback — either the caller override, or the built-in styled notice.
  if (notConfigured || error) {
    if (fallback != null) {
      return <div style={containerStyle}>{fallback}</div>
    }
    return (
      <div style={noticeStyle} role="note">
        <span style={noticeTitleStyle}>3D / DWG viewer not available</span>
        {error ? (
          <span>{error}</span>
        ) : (
          <span>
            3D / DWG viewing requires APS credentials (not configured). Attach a
            PDF submission to view plans.
          </span>
        )}
      </div>
    )
  }

  return <div ref={containerRef} style={containerStyle} />
}
