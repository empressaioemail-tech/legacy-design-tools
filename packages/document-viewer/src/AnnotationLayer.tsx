import { useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { Annotation, AnnotationKind } from './types'
import type { MarkupTool } from './MarkupTools'

export type AnnotationLayerProps = {
  annotations: Annotation[]
  canvasRef: RefObject<HTMLCanvasElement | null>
  page: number
  submissionId?: string
  /** Engagement the drawn annotation belongs to (stamped onto onAdd payloads). */
  engagementId?: string
  /** Author id stamped onto drawn annotations. Defaults to `'reviewer'`. */
  currentUser?: string
  activeTool?: MarkupTool | null
  onAdd?: (annotation: Omit<Annotation, 'id' | 'createdAt'>) => void
  /** Bidirectional finding highlight — fired when a callout is clicked. */
  onSelectFinding?: (findingId: string) => void
}

type NormPoint = { x: number; y: number }

type DraftRect = { start: NormPoint; current: NormPoint }

/** Map the UI toolbar vocabulary onto the persisted annotation kind. */
function toolToKind(tool: MarkupTool): AnnotationKind {
  switch (tool) {
    case 'pen':
      return 'redline'
    case 'shape':
      return 'shape'
    case 'text':
      return 'text'
    case 'stamp':
      return 'stamp'
  }
}

function defaultLabelForTool(tool: MarkupTool): string {
  switch (tool) {
    case 'pen':
      return 'Redline'
    case 'shape':
      return 'Shape'
    case 'text':
      return 'Text'
    case 'stamp':
      return 'Stamp'
  }
}

/** Convert a pointer event into a 0..1 normalized point relative to the SVG box. */
function toNormPoint(
  evt: { clientX: number; clientY: number },
  el: SVGSVGElement,
): NormPoint {
  const rect = el.getBoundingClientRect()
  const width = rect.width || 1
  const height = rect.height || 1
  const x = (evt.clientX - rect.left) / width
  const y = (evt.clientY - rect.top) / height
  return {
    x: Math.min(Math.max(x, 0), 1),
    y: Math.min(Math.max(y, 0), 1),
  }
}

/** Sorted [x1,y1,x2,y2] so x1<x2, y1<y2 regardless of drag direction. */
function sortedBbox(
  a: NormPoint,
  b: NormPoint,
): [number, number, number, number] {
  return [
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.max(a.x, b.x),
    Math.max(a.y, b.y),
  ]
}

const svgBaseStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
}

const CALLOUT_RADIUS = 12

type AnnotationCalloutProps = {
  annotation: Annotation
  index: number
  width: number
  height: number
  onSelectFinding?: (findingId: string) => void
}

function AnnotationCallout(props: AnnotationCalloutProps): ReactNode {
  const { annotation, index, width, height, onSelectFinding } = props
  const loc = annotation.location2d
  if (!loc) return null
  const [x1, y1, x2, y2] = loc.bbox
  const px1 = x1 * width
  const py1 = y1 * height
  const px2 = x2 * width
  const py2 = y2 * height
  const boxW = Math.max(px2 - px1, 0)
  const boxH = Math.max(py2 - py1, 0)

  const clickable = Boolean(annotation.findingId)
  const handleClick = (): void => {
    if (annotation.findingId && onSelectFinding) {
      onSelectFinding(annotation.findingId)
    }
  }

  return (
    <g
      style={{
        cursor: clickable ? 'pointer' : 'default',
        // The parent <svg> is pointerEvents:'none' while no markup tool is
        // active (so drawing does not intercept clicks), and that inherits
        // down to every child. Re-enable pointer events on a clickable callout
        // so the bidirectional callout->finding highlight works in the normal
        // (no-tool) viewing state, not only while a markup tool is selected.
        pointerEvents: clickable ? 'all' : 'none',
      }}
      onClick={handleClick}
      role={clickable ? 'button' : undefined}
      aria-label={loc.label}
    >
      <rect
        x={px1}
        y={py1}
        width={boxW}
        height={boxH}
        fill="var(--h-accent)"
        fillOpacity={0.08}
        stroke="var(--h-accent)"
        strokeWidth={1.5}
        rx={4}
      />
      <circle
        cx={px1}
        cy={py1}
        r={CALLOUT_RADIUS}
        fill="var(--h-accent)"
        stroke="var(--h-surface-0)"
        strokeWidth={1.5}
      />
      <text
        x={px1}
        y={py1}
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--h-surface-0)"
        fontFamily="var(--h-font-sans)"
        fontSize={12}
        fontWeight={600}
      >
        {index + 1}
      </text>
      <text
        x={px1 + CALLOUT_RADIUS + 4}
        y={py1}
        dominantBaseline="central"
        fill="var(--h-text-primary)"
        fontFamily="var(--h-font-sans)"
        fontSize={12}
      >
        {loc.label}
      </text>
    </g>
  )
}

export function AnnotationLayer(props: AnnotationLayerProps): ReactNode {
  const {
    annotations,
    canvasRef,
    page,
    submissionId,
    engagementId,
    currentUser = 'reviewer',
    activeTool = null,
    onAdd,
    onSelectFinding,
  } = props

  const svgRef = useRef<SVGSVGElement | null>(null)
  const [draft, setDraft] = useState<DraftRect | null>(null)

  const canvas = canvasRef.current
  // Fall back to 0 until the canvas has rendered; the SVG re-renders once the
  // parent re-renders with a sized canvas (PDFViewer flips loading -> false).
  const width = canvas?.width ?? 0
  const height = canvas?.height ?? 0

  const pageAnnotations = annotations.filter(
    (a) => a.location2d != null && a.location2d.page === page,
  )

  const drawingEnabled = Boolean(activeTool)

  const handleMouseDown = (evt: React.MouseEvent<SVGSVGElement>): void => {
    if (!drawingEnabled || !svgRef.current) return
    const p = toNormPoint(evt, svgRef.current)
    setDraft({ start: p, current: p })
  }

  const handleMouseMove = (evt: React.MouseEvent<SVGSVGElement>): void => {
    if (!draft || !svgRef.current) return
    const p = toNormPoint(evt, svgRef.current)
    setDraft({ start: draft.start, current: p })
  }

  const finalizeDraft = (): void => {
    if (!draft || !activeTool) {
      setDraft(null)
      return
    }
    const bbox = sortedBbox(draft.start, draft.current)
    // Ignore zero-area clicks (no real drag) so a stray click doesn't create
    // a degenerate annotation.
    const hasArea = bbox[2] - bbox[0] > 0.002 || bbox[3] - bbox[1] > 0.002
    if (hasArea && onAdd) {
      const label = defaultLabelForTool(activeTool)
      onAdd({
        engagementId: engagementId ?? '',
        author: currentUser,
        kind: toolToKind(activeTool),
        location2d: {
          submissionId: submissionId ?? '',
          page,
          bbox,
          label,
        },
      })
    }
    setDraft(null)
  }

  const draftBox = draft ? sortedBbox(draft.start, draft.current) : null

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ ...svgBaseStyle, pointerEvents: activeTool ? 'all' : 'none' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={finalizeDraft}
      onMouseLeave={() => {
        if (draft) finalizeDraft()
      }}
      role="group"
      aria-label="Annotation overlay"
    >
      {pageAnnotations.map((annotation, index) => (
        <AnnotationCallout
          key={annotation.id}
          annotation={annotation}
          index={index}
          width={width}
          height={height}
          onSelectFinding={onSelectFinding}
        />
      ))}
      {draftBox ? (
        <rect
          x={draftBox[0] * width}
          y={draftBox[1] * height}
          width={(draftBox[2] - draftBox[0]) * width}
          height={(draftBox[3] - draftBox[1]) * height}
          fill="var(--h-accent)"
          fillOpacity={0.12}
          stroke="var(--h-accent)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ) : null}
    </svg>
  )
}
