import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  PDFViewer,
  PageControls,
  VersionPicker,
  MarkupToolbar,
  DWGViewer,
  type MarkupTool,
  type Annotation,
} from '@empressaio/document-viewer'
import {
  useEngagement,
  TileStatusBanner,
  useAnnotationSelection,
  useDocumentViewerNavigation,
} from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

type EngagementDocumentWire = {
  id: string
  title: string
  documentType: string
  url: string | null
  createdAt: string
}

type EngagementAnnotationWire = {
  id: string
  findingId: string | null
  author: string
  kind: string
  confidence: number | null
  location2d: { page: number; x: number; y: number; width: number; height: number } | null
  location3d: { globalId: string; label: string } | null
  createdAt: string
}

type Submission = {
  id: string
  label: string
  submittedAt: string
  status: string
}

function isPdfDocument(doc: EngagementDocumentWire): boolean {
  const t = doc.title.toLowerCase()
  if (t.endsWith('.pdf')) return true
  if (t.endsWith('.dwg') || t.endsWith('.rvt') || t.endsWith('.ifc')) return false
  return doc.documentType !== 'product-data'
}

function DocumentViewerTileInner() {
  const { engagementId } = useEngagement()
  const client = useCortexClient()
  const { selectAnnotation } = useAnnotationSelection()
  const { onRequestPage, publishFindingPages } = useDocumentViewerNavigation()

  const [documents, setDocuments] = useState<EngagementDocumentWire[]>([])
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [annotations, setAnnotations] = useState<EngagementAnnotationWire[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [markupTool, setMarkupTool] = useState<MarkupTool | null>(null)
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const [generating, setGenerating] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [genProgress, setGenProgress] = useState<{ progress: number; total: number }>({ progress: 0, total: 0 })

  const refetchAnnotations = useMemo(
    () => async (id: string) => {
      try {
        const data = await client.fetch<{ annotations: EngagementAnnotationWire[] }>(
          `/plan-review/engagements/${id}/annotations`,
        )
        setAnnotations(data.annotations ?? [])
      } catch {
        // Non-fatal
      }
    },
    [client],
  )

  useEffect(() => {
    if (!engagementId) {
      setDocuments([])
      setSubmissions([])
      setAnnotations([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      client.listEngagementDocuments(engagementId),
      client.getSubmissions(engagementId),
      client.fetch<{ annotations: EngagementAnnotationWire[] }>(`/plan-review/engagements/${engagementId}/annotations`),
    ])
      .then(([docsRes, subs, annRes]) => {
        if (cancelled) return
        setDocuments(docsRes.documents ?? [])
        const mapped: Submission[] = subs.map((s) => ({
          id: s.id,
          label: s.discipline ? s.discipline : new Date(s.submittedAt).toLocaleDateString(),
          submittedAt: s.submittedAt,
          status: s.status,
        }))
        setSubmissions(mapped)
        setAnnotations(annRes.annotations ?? [])
        setPage(1)
        setActiveSubmissionId(mapped.length > 0 ? mapped[mapped.length - 1].id : null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load documents')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  const viewableDoc: EngagementDocumentWire | null = useMemo(() => {
    const withUrl = documents.filter((d) => d.url)
    if (withUrl.length === 0) return null
    return withUrl[withUrl.length - 1]
  }, [documents])

  const pageAnnotations: Annotation[] = useMemo(
    () =>
      annotations
        .filter((a) => a.location2d != null && a.location2d.page === page)
        .map((a) => ({
          id: a.id,
          engagementId: engagementId ?? '',
          findingId: a.findingId ?? undefined,
          author: a.author,
          kind: a.kind as any,
          confidence: a.confidence as any,
          location2d: a.location2d as any,
          location3d: a.location3d as any,
          createdAt: a.createdAt,
        })),
    [annotations, page, engagementId],
  )

  const annotations3d = useMemo(
    () =>
      annotations
        .filter((a) => a.location3d != null)
        .map((a) => ({
          globalId: a.location3d!.globalId,
          label: a.location3d!.label,
        })),
    [annotations],
  )

  useEffect(
    () =>
      onRequestPage((p) => {
        setPage((_prev) => {
          const upper = pageCount || p
          return Math.min(Math.max(1, p), Math.max(1, upper))
        })
      }),
    [onRequestPage, pageCount],
  )

  useEffect(() => {
    const map: Record<string, number> = {}
    for (const a of annotations) {
      const fid = a.findingId
      const page2d = a.location2d?.page
      if (!fid || typeof page2d !== 'number') continue
      const existing = map[fid]
      if (existing === undefined || page2d < existing) map[fid] = page2d
    }
    publishFindingPages(map)
  }, [annotations, publishFindingPages])

  const refetchRef = useRef(refetchAnnotations)
  refetchRef.current = refetchAnnotations
  const engagementIdRef = useRef(engagementId)
  engagementIdRef.current = engagementId

  useEffect(() => {
    if (!jobId) return
    const eid = engagementIdRef.current
    if (!eid) return
    let stopped = false
    const interval = setInterval(() => {
      void client
        .fetch<{
          status: string
          progress: number
          total: number
          error?: string | null
        }>(`/plan-review/engagements/${eid}/annotations/generation/${jobId}/status`)
        .then((s) => {
          if (stopped) return
          setGenProgress({ progress: s.progress, total: s.total })
          if (s.status === 'done' || s.status === 'error') {
            stopped = true
            clearInterval(interval)
            if (s.status === 'error') setGenerateError(s.error ?? 'Annotation generation failed')
            setGenerating(false)
            setJobId(null)
            void refetchRef.current(eid)
          }
        })
        .catch((err: unknown) => {
          if (stopped) return
          stopped = true
          clearInterval(interval)
          setGenerateError(err instanceof Error ? err.message : 'Status check failed')
          setGenerating(false)
          setJobId(null)
        })
    }, 3000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [jobId, client])

  const hasAiAnnotations = useMemo(() => annotations.some((a) => a.author === 'ai'), [annotations])

  async function onGenerateAnnotations() {
    if (!engagementId || !activeSubmissionId) return
    setGenerateError(null)
    setGenProgress({ progress: 0, total: 0 })
    setGenerating(true)
    try {
      const res = await client.fetch<{ jobId: string }>(
        `/plan-review/engagements/${engagementId}/annotations/generate`,
        {
          method: 'POST',
          body: JSON.stringify({ submissionId: activeSubmissionId }),
        },
      )
      setJobId(res.jobId)
    } catch (err: unknown) {
      setGenerating(false)
      setGenerateError(err instanceof Error ? err.message : 'Failed to start generation')
    }
  }

  async function onExport() {
    if (!engagementId) return
    setExporting(true)
    setExportError(null)
    try {
      const res = await client.fetch<{ url: string }>(`/plan-review/engagements/${engagementId}/export-pdf`, {
        method: 'POST',
        body: '{}',
      })
      const a = document.createElement('a')
      a.href = res.url
      a.download = `review-${engagementId.slice(0, 8)}.pdf`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  async function onAnnotationAdd(annotation: Omit<Annotation, 'id' | 'createdAt'>) {
    if (!engagementId) return
    try {
      await client.fetch(`/plan-review/engagements/${engagementId}/annotations`, {
        method: 'POST',
        body: JSON.stringify({
          author: annotation.author,
          kind: annotation.kind,
          findingId: annotation.findingId,
          confidence: annotation.confidence,
          location2d: annotation.location2d,
          location3d: annotation.location3d,
        }),
      })
      await refetchAnnotations(engagementId)
    } catch {
      // Non-fatal
    }
  }

  if (!engagementId) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <TileStatusBanner status="live" label="Document Viewer" />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Select a case first.</span>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <TileStatusBanner status="live" label="Document Viewer" />

      {loading ? (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>
      ) : error ? (
        <div role="alert" style={{ fontSize: 12, color: 'var(--danger-text)' }}>
          {error}
        </div>
      ) : documents.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No documents uploaded.</span>
      ) : (
        <>
          <div style={rowStyle}>
            {submissions.length > 0 ? (
              <VersionPicker
                submissions={submissions}
                activeId={activeSubmissionId ?? undefined}
                onSelect={setActiveSubmissionId}
              />
            ) : null}
            <MarkupToolbar active={markupTool} onSelect={setMarkupTool} />
            <button
              type="button"
              onClick={() => void onExport()}
              disabled={exporting}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                background: exporting ? 'var(--surface-2, transparent)' : 'transparent',
                color: 'var(--text-primary)',
                cursor: exporting ? 'not-allowed' : 'pointer',
                fontSize: 12,
              }}
            >
              {exporting ? 'Exporting…' : 'Export annotated PDF'}
            </button>

            {generating ? (
              <span role="status" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {genProgress.total > 0 ? `Generating… ${genProgress.progress}/${genProgress.total}` : 'Generating…'}
              </span>
            ) : engagementId && documents.length > 0 && activeSubmissionId && !hasAiAnnotations ? (
              <button
                type="button"
                data-testid="generate-annotations-button"
                onClick={() => void onGenerateAnnotations()}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Generate AI Annotations
              </button>
            ) : null}
          </div>

          {exportError ? (
            <div role="alert" style={{ fontSize: 12, color: 'var(--danger-text)' }}>
              {exportError}
            </div>
          ) : null}

          {generateError ? (
            <div role="alert" style={{ fontSize: 12, color: 'var(--danger-text)' }}>
              {generateError}
            </div>
          ) : null}

          <span style={labelStyle}>{viewableDoc ? viewableDoc.title : 'Document'}</span>

          {viewableDoc && viewableDoc.url ? (
            isPdfDocument(viewableDoc) ? (
              <>
                <PDFViewer
                  url={viewableDoc.url}
                  page={page}
                  scale={scale}
                  onPageCount={setPageCount}
                  annotations={pageAnnotations}
                  onAnnotationAdd={(a: Omit<Annotation, 'id' | 'createdAt'>) => void onAnnotationAdd(a)}
                  markupTool={markupTool}
                  engagementId={engagementId}
                  currentUser="reviewer"
                  submissionId={activeSubmissionId ?? undefined}
                  onSelectFinding={selectAnnotation}
                />
                <PageControls page={page} pageCount={pageCount} onPage={setPage} scale={scale} onScale={setScale} />
              </>
            ) : (
              <div style={{ height: 480 }}>
                <DWGViewer annotations3d={annotations3d} />
              </div>
            )
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No viewable document (documents present but none have a signed URL).
            </span>
          )}
        </>
      )}
    </div>
  )
}

export function DocumentViewerTile() {
  return (
    <TileErrorBoundary label="Document Viewer">
      <DocumentViewerTileInner />
    </TileErrorBoundary>
  )
}
