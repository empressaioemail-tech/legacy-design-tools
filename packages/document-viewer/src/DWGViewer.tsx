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
  /**
   * Track F Phase 3 — DISPLAY-ONLY 3D annotation overlay. Each entry is a
   * `location3d` annotation (an IFC `globalId` plus optional label). When the
   * model is loaded and APS is configured, these elements are located via the
   * viewer's `search()` and highlighted (`select` + `isolate`). This track does
   * NOT generate 3D coordinates (that needs IFC parsing — a separate
   * workstream); it only renders coordinates already stored in `location3d`.
   *
   * This is entirely gated behind the APS-configured path: with no APS
   * credentials the component sits in its named `aps_not_configured` fallback
   * and this prop has no effect (cannot be runtime-verified without creds).
   */
  annotations3d?: Array<{ globalId: string; label?: string }>
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

/**
 * DISPLAY-ONLY (Track F Phase 3). Highlight the model elements named by a set of
 * `location3d` annotations, via the APS viewer's `search()` over IFC GlobalId.
 * Best-effort and side-effect-only: any failure is swallowed so a bad globalId
 * never breaks the viewer. No-op when there are no annotations.
 */
function highlightAnnotations3d(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external untyped APS Viewer instance
  viewer: any,
  annotations3d: Array<{ globalId: string; label?: string }>,
): void {
  if (!viewer || annotations3d.length === 0) return
  try {
    const dbIds: number[] = []
    let pending = annotations3d.length
    for (const ann of annotations3d) {
      try {
        viewer.search(
          ann.globalId,
          (ids: number[]) => {
            if (Array.isArray(ids)) dbIds.push(...ids)
            pending -= 1
            // Once every search has reported back, apply the selection +
            // isolate in one pass so the highlighted elements are visible.
            if (pending <= 0 && dbIds.length > 0) {
              try {
                viewer.select(dbIds)
                viewer.isolate(dbIds)
              } catch {
                // best-effort — never throw out of an APS callback
              }
            }
          },
          () => {
            pending -= 1
          },
          // Search IFC GlobalId; APS matches against object properties.
          ['GlobalId', 'globalId', 'IfcGUID'],
        )
      } catch {
        pending -= 1
      }
    }
  } catch {
    // Never let a display-only highlight break the viewer.
  }
}

export function DWGViewer(props: DWGViewerProps): ReactNode {
  const { urn, getViewerToken, onReady, fallback, annotations3d } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The live APS viewer instance, retained so 3D annotation highlights can be
  // (re)applied when `annotations3d` changes after the model has loaded.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external untyped APS Viewer instance
  const viewerRef = useRef<any>(null)
  const [modelReady, setModelReady] = useState(false)
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
        viewerRef.current = viewer
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
                setModelReady(true)
                // Apply any 3D annotation highlights present at load time.
                // Later changes are handled by the annotations3d effect below.
                if (annotations3d && annotations3d.length > 0) {
                  highlightAnnotations3d(viewer, annotations3d)
                }
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
      setModelReady(false)
      viewerRef.current = null
      // Tear down the viewer so we never leak a WebGL context across remounts.
      if (viewer && typeof viewer.finish === 'function') {
        try {
          viewer.finish()
        } catch {
          // Best-effort teardown; a failing finish() must never throw upward.
        }
      }
    }
    // annotations3d is intentionally NOT a dependency: changing the 3D
    // annotation set must re-apply highlights (handled by the effect below),
    // never reload the model / recreate the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notConfigured, urn, getViewerToken, onReady])

  // DISPLAY-ONLY: re-apply 3D annotation highlights when the set changes and the
  // model is loaded. No-op (and never reached) while APS is not configured.
  useEffect(() => {
    if (!modelReady || !viewerRef.current) return
    highlightAnnotations3d(viewerRef.current, annotations3d ?? [])
  }, [modelReady, annotations3d])

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
