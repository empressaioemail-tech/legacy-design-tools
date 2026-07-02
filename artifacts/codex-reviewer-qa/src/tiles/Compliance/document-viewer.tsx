import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";
import {
  fetchEngagementDocuments,
  fetchEngagementSubmissions,
  fetchEngagementAnnotations,
  createEngagementAnnotation,
  exportEngagementPdf,
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
          </div>

          {exportError ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
              {exportError}
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
                <DWGViewer />
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
