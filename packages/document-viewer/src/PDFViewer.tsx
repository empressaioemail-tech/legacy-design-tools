import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { Annotation } from './types'
import { AnnotationLayer } from './AnnotationLayer'
import type { MarkupTool } from './MarkupTools'

// Configure the pdf.js worker (pdfjs-dist v4 ships an ESM worker).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

// `MarkupTool` is defined canonically in `./MarkupTools`. Re-exported here for
// backward compatibility with any consumer importing it from `PDFViewer`.
export type { MarkupTool } from './MarkupTools'

export type PDFViewerProps = {
  url: string
  page?: number
  scale?: number
  onPageCount?: (count: number) => void
  annotations?: Annotation[]
  /** Called when the AnnotationLayer finalizes a freshly-drawn annotation. */
  onAnnotationAdd?: (annotation: Omit<Annotation, 'id' | 'createdAt'>) => void
  markupTool?: MarkupTool | null
  /** Engagement id stamped onto drawn annotations (threaded to AnnotationLayer). */
  engagementId?: string
  /** Author id stamped onto drawn annotations. Defaults inside AnnotationLayer. */
  currentUser?: string
  /** Submission the current document belongs to (stamped into location2d). */
  submissionId?: string
  /** Bidirectional finding highlight — fired when an annotation callout is clicked. */
  onSelectFinding?: (findingId: string) => void
  /**
   * Optional overlay content rendered on top of the canvas, layered above the
   * AnnotationLayer.
   */
  children?: ReactNode
}

const wrapStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  background: 'var(--h-surface-1)',
  borderRadius: 'var(--h-radius-md)',
  border: '1px solid var(--h-border-subtle)',
}

const stateStyle: CSSProperties = {
  padding: 'var(--h-space-lg)',
  fontFamily: 'var(--h-font-sans)',
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
  background: 'var(--h-surface-1)',
  borderRadius: 'var(--h-radius-md)',
  border: '1px solid var(--h-border-subtle)',
}

const errorStyle: CSSProperties = {
  ...stateStyle,
  color: 'var(--h-error)',
  borderColor: 'var(--h-error)',
}

export function PDFViewer(props: PDFViewerProps): ReactNode {
  const {
    url,
    page = 1,
    scale = 1.5,
    onPageCount,
    annotations = [],
    onAnnotationAdd,
    markupTool = null,
    engagementId,
    currentUser,
    submissionId,
    onSelectFinding,
    children,
  } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let renderTask: pdfjsLib.RenderTask | null = null
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null

    setLoading(true)
    setError(null)

    const run = async (): Promise<void> => {
      try {
        loadingTask = pdfjsLib.getDocument(url)
        const doc = await loadingTask.promise
        if (cancelled) return

        if (onPageCount) onPageCount(doc.numPages)

        const clampedPage = Math.min(Math.max(page, 1), doc.numPages)
        const pdfPage = await doc.getPage(clampedPage)
        if (cancelled) return

        const viewport = pdfPage.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas) return
        const canvasContext = canvas.getContext('2d')
        if (!canvasContext) {
          setError('Document viewer failed: no 2D canvas context available.')
          setLoading(false)
          return
        }

        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)

        renderTask = pdfPage.render({ canvasContext, viewport })
        await renderTask.promise
        if (cancelled) return
        setLoading(false)
      } catch (err: unknown) {
        if (cancelled) return
        // pdf.js throws a RenderingCancelledException when .cancel() is called;
        // that is expected on stale renders and must not surface as an error.
        const name = (err as { name?: string } | null)?.name
        if (name === 'RenderingCancelledException') return
        const message = err instanceof Error ? err.message : String(err)
        setError(`Document failed to load: ${message}`)
        setLoading(false)
      }
    }

    void run()

    return () => {
      cancelled = true
      // Cancel a stale in-flight render so pdf.js does not throw
      // "Cannot use the same canvas during multiple render() operations".
      if (renderTask) renderTask.cancel()
      if (loadingTask) void loadingTask.destroy()
    }
  }, [url, page, scale, onPageCount])

  if (error) {
    return <div style={errorStyle}>{error}</div>
  }

  return (
    <div style={wrapStyle}>
      {loading ? <div style={stateStyle}>Loading document…</div> : null}
      <canvas ref={canvasRef} style={{ display: loading ? 'none' : 'block' }} />
      {/* Phase 2: real AnnotationLayer overlay, sized to the rendered canvas.
          Only mounted once the page has painted so the canvas has real
          width/height for normalized-bbox projection. */}
      {loading ? null : (
        <AnnotationLayer
          annotations={annotations}
          canvasRef={canvasRef}
          page={page}
          submissionId={submissionId}
          engagementId={engagementId}
          currentUser={currentUser}
          activeTool={markupTool}
          onAdd={onAnnotationAdd}
          onSelectFinding={onSelectFinding}
        />
      )}
      {/* Extra parent-supplied overlay content, layered above the annotations. */}
      {children != null ? (
        <div
          data-annotation-layer-seam
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
