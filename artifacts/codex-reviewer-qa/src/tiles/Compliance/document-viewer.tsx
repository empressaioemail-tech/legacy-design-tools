import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  PDFViewer,
  PageControls,
  VersionPicker,
  MarkupToolbar,
  DWGViewer,
  type Submission,
  type MarkupTool,
  type Annotation,
} from "@hauska/document-viewer";
import {
  useEngagement,
  TileStatusBanner,
  useAnnotationSelection,
  useDocumentViewerNavigation,
} from "@hauska/tile-shell";
import {
  fetchEngagementDocuments,
  fetchEngagementSubmissions,
  fetchEngagementAnnotations,
  createEngagementAnnotation,
  exportEngagementPdf,
  generateEngagementAnnotations,
  getAnnotationGenerationStatus,
  type EngagementDocumentWire,
  type EngagementAnnotationWire,
} from "../../lib/planReviewBff";

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

function isPdfDocument(doc: EngagementDocumentWire): boolean {
  const t = doc.title.toLowerCase();
  if (t.endsWith(".pdf")) return true;
  if (t.endsWith(".dwg") || t.endsWith(".rvt") || t.endsWith(".ifc")) {
    return false;
  }
  // Uploaded plan sets default to the `narrative` document type and are the
  // viewable-PDF path in v1; treat unknown extensions optimistically as PDF so
  // the PDFViewer can surface a real load error rather than silently routing to
  // the DWG fallback.
  return doc.documentType !== "product-data";
}

export default function DocumentViewerTile() {
  const { engagementId } = useEngagement();
  const { selectAnnotation } = useAnnotationSelection();
  const { onRequestPage, publishFindingPages } = useDocumentViewerNavigation();

  const [documents, setDocuments] = useState<EngagementDocumentWire[]>([]);
  const [submissions, setSubmissions] = useState<
    Awaited<ReturnType<typeof fetchEngagementSubmissions>>
  >([]);
  const [annotations, setAnnotations] = useState<EngagementAnnotationWire[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Viewer UI state.
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.5);
  const [markupTool, setMarkupTool] = useState<MarkupTool | null>(null);
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(
    null,
  );

  // Export state.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // AI-annotation generation state.
  const [generating, setGenerating] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState<{
    progress: number;
    total: number;
  }>({ progress: 0, total: 0 });

  const refetchAnnotations = useMemo(
    () => async (id: string) => {
      try {
        const { annotations: rows } = await fetchEngagementAnnotations(id);
        setAnnotations(rows);
      } catch {
        // Non-fatal: annotations overlay is best-effort; keep the last set.
      }
    },
    [],
  );

  useEffect(() => {
    if (!engagementId) {
      setDocuments([]);
      setSubmissions([]);
      setAnnotations([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchEngagementDocuments(engagementId),
      fetchEngagementSubmissions(engagementId),
      fetchEngagementAnnotations(engagementId),
    ])
      .then(([docsRes, subs, annRes]) => {
        if (cancelled) return;
        setDocuments(docsRes.documents);
        setSubmissions(subs);
        setAnnotations(annRes.annotations);
        setPage(1);
        setActiveSubmissionId(subs.length > 0 ? subs[subs.length - 1].id : null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load documents",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  // The submission versions rendered by VersionPicker.
  const versionSubmissions: Submission[] = useMemo(
    () =>
      submissions.map((s) => ({
        id: s.id,
        label: s.discipline
          ? `${s.discipline}`
          : new Date(s.submittedAt).toLocaleDateString(),
        submittedAt: s.submittedAt,
        status: s.status,
      })),
    [submissions],
  );

  // v1 mapping note: submissions and attached documents are not linked by a
  // foreign key in the current schema, so we cannot resolve submission -> exact
  // document. The viewable url is therefore the engagement's LATEST document
  // that has a signed url; VersionPicker acts as a visual submission chain and
  // does not (yet) re-point the viewer. When the submission<->document link
  // lands, key the chosen document off `activeSubmissionId` here.
  const viewableDoc: EngagementDocumentWire | null = useMemo(() => {
    const withUrl = documents.filter((d) => d.url);
    if (withUrl.length === 0) return null;
    return withUrl[withUrl.length - 1];
  }, [documents]);

  // Annotations for the current page (package `Annotation` shape is structurally
  // identical to the wire type, so this is a direct pass-through).
  const pageAnnotations: Annotation[] = useMemo(
    () =>
      annotations.filter(
        (a) => a.location2d != null && a.location2d.page === page,
      ) as Annotation[],
    [annotations, page],
  );

  // Phase 3 (DISPLAY-ONLY): 3D annotations for the DWGViewer. Elements are
  // highlighted by IFC globalId when APS is configured; with no APS creds the
  // DWGViewer sits in its named fallback and this has no effect.
  const annotations3d = useMemo(
    () =>
      annotations
        .filter((a) => a.location3d != null)
        .map((a) => ({
          globalId: a.location3d!.globalId,
          label: a.location3d!.label,
        })),
    [annotations],
  );

  // Finding-card click -> page jump (viewer side): subscribe to the nav bus.
  // onRequestPage returns its own unsubscribe, which we return from the effect
  // so React cleans up the subscription. Guard the page into [1, pageCount||p].
  useEffect(
    () =>
      onRequestPage((p) => {
        setPage((_prev) => {
          const upper = pageCount || p;
          return Math.min(Math.max(1, p), Math.max(1, upper));
        });
      }),
    [onRequestPage, pageCount],
  );

  // Publish the finding->page map whenever annotations change. First/lowest
  // page wins if a finding has multiple located annotations.
  useEffect(() => {
    const map: Record<string, number> = {};
    for (const a of annotations) {
      const fid = a.findingId;
      const page2d = a.location2d?.page;
      if (!fid || typeof page2d !== "number") continue;
      const existing = map[fid];
      if (existing === undefined || page2d < existing) {
        map[fid] = page2d;
      }
    }
    publishFindingPages(map);
  }, [annotations, publishFindingPages]);

  // Stable ref to the latest refetch, so the polling effect can call it on
  // terminal status WITHOUT depending on it (effect stays keyed on jobId only).
  const refetchRef = useRef(refetchAnnotations);
  refetchRef.current = refetchAnnotations;
  const engagementIdRef = useRef(engagementId);
  engagementIdRef.current = engagementId;

  // Poll generation status while a job is in flight. Depends ONLY on jobId:
  // it starts when jobId is set (by the button onClick) and stops on terminal
  // status (interval cleared) or when jobId clears. Generation is NEVER
  // triggered from an effect, so the post-completion refetch cannot re-fire it.
  useEffect(() => {
    if (!jobId) return;
    const eid = engagementIdRef.current;
    if (!eid) return;
    let stopped = false;
    const interval = setInterval(() => {
      void getAnnotationGenerationStatus(eid, jobId)
        .then((s) => {
          if (stopped) return;
          setGenProgress({ progress: s.progress, total: s.total });
          if (s.status === "done" || s.status === "error") {
            stopped = true;
            clearInterval(interval);
            if (s.status === "error") {
              setGenerateError(s.error ?? "Annotation generation failed");
            }
            setGenerating(false);
            setJobId(null);
            void refetchRef.current(eid);
          }
        })
        .catch((err: unknown) => {
          if (stopped) return;
          stopped = true;
          clearInterval(interval);
          setGenerateError(
            err instanceof Error ? err.message : "Status check failed",
          );
          setGenerating(false);
          setJobId(null);
        });
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [jobId]);

  const hasAiAnnotations = useMemo(
    () => annotations.some((a) => a.author === "ai"),
    [annotations],
  );

  async function onGenerateAnnotations() {
    if (!engagementId || !activeSubmissionId) return;
    setGenerateError(null);
    setGenProgress({ progress: 0, total: 0 });
    setGenerating(true);
    try {
      const { jobId: newJobId } = await generateEngagementAnnotations(
        engagementId,
        activeSubmissionId,
      );
      setJobId(newJobId);
    } catch (err: unknown) {
      setGenerating(false);
      setGenerateError(
        err instanceof Error ? err.message : "Failed to start generation",
      );
    }
  }

  async function onExport() {
    if (!engagementId) return;
    setExporting(true);
    setExportError(null);
    try {
      const { url } = await exportEngagementPdf(engagementId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function onAnnotationAdd(
    annotation: Omit<Annotation, "id" | "createdAt">,
  ) {
    if (!engagementId) return;
    try {
      await createEngagementAnnotation(engagementId, {
        author: annotation.author,
        kind: annotation.kind,
        findingId: annotation.findingId,
        confidence: annotation.confidence,
        location2d: annotation.location2d,
        location3d: annotation.location3d,
      });
      await refetchAnnotations(engagementId);
    } catch {
      // Draw failed to persist — leave the overlay unchanged; the reviewer can
      // retry. Surface nothing intrusive for a scratch markup.
    }
  }

  if (!engagementId) {
    return (
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <TileStatusBanner status="live" label="Document Viewer" />
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Select a case first.
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <TileStatusBanner status="live" label="Document Viewer" />

      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span>
      ) : error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : documents.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No documents uploaded.
        </span>
      ) : (
        <>
          <div style={rowStyle}>
            {versionSubmissions.length > 0 ? (
              <VersionPicker
                submissions={versionSubmissions}
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
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border-subtle)",
                background: exporting ? "var(--surface-2, transparent)" : "transparent",
                color: "var(--text-primary)",
                cursor: exporting ? "not-allowed" : "pointer",
                fontSize: 12,
              }}
            >
              {exporting ? "Exporting…" : "Export annotated PDF"}
            </button>

            {generating ? (
              <span
                role="status"
                style={{ fontSize: 12, color: "var(--text-muted)" }}
              >
                {genProgress.total > 0
                  ? `Generating… ${genProgress.progress}/${genProgress.total}`
                  : "Generating…"}
              </span>
            ) : engagementId &&
              documents.length > 0 &&
              activeSubmissionId &&
              !hasAiAnnotations ? (
              <button
                type="button"
                data-testid="generate-annotations-button"
                onClick={() => void onGenerateAnnotations()}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border-subtle)",
                  background: "transparent",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Generate AI Annotations
              </button>
            ) : null}
          </div>

          {exportError ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
              {exportError}
            </div>
          ) : null}

          {generateError ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
              {generateError}
            </div>
          ) : null}

          <span style={labelStyle}>
            {viewableDoc ? viewableDoc.title : "Document"}
          </span>

          {viewableDoc && viewableDoc.url ? (
            isPdfDocument(viewableDoc) ? (
              <>
                <PDFViewer
                  url={viewableDoc.url}
                  page={page}
                  scale={scale}
                  onPageCount={setPageCount}
                  annotations={pageAnnotations}
                  onAnnotationAdd={(a) => void onAnnotationAdd(a)}
                  markupTool={markupTool}
                  engagementId={engagementId}
                  currentUser="reviewer"
                  submissionId={activeSubmissionId ?? undefined}
                  onSelectFinding={selectAnnotation}
                />
                <PageControls
                  page={page}
                  pageCount={pageCount}
                  onPage={setPage}
                  scale={scale}
                  onScale={setScale}
                />
              </>
            ) : (
              // Non-PDF (DWG/RVT/IFC): APS is not configured in this
              // environment, so DWGViewer renders its named fallback notice.
              <div style={{ height: 480 }}>
                <DWGViewer annotations3d={annotations3d} />
              </div>
            )
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              No viewable document (documents present but none have a signed
              URL).
            </span>
          )}
        </>
      )}
    </div>
  );
}
