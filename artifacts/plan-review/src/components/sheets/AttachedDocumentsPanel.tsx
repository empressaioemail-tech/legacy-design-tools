import { useState } from "react";
import {
  useListAttachedDocuments,
  getListAttachedDocumentsQueryKey,
  type AttachedDocumentAtom,
} from "@workspace/api-client-react";

/**
 * Cortex L2b (Lane C.4 / C.4.2) — attached-documents panel.
 *
 * Plan-review (reviewer) side: lists the supporting documents attached
 * to the engagement (specification sections, structural calculations,
 * product-data sheets, design narratives) with a per-document
 * extracted-text viewer.
 *
 * Read-only by contract — `attached-document` atoms are produced by the
 * sheet-ingest pipeline, not an HTTP create. The panel self-explains
 * its empty state because no producer ships in C.4.2 (see the C.4.2
 * PR's open-items note).
 */

const DOCUMENT_TYPE_LABELS: Record<
  AttachedDocumentAtom["documentType"],
  string
> = {
  specification: "Specification",
  calculation: "Calculation",
  "product-data": "Product data",
  narrative: "Narrative",
};

function AttachedDocumentRow({ doc }: { doc: AttachedDocumentAtom }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid={`attached-document-row-${doc.entityId}`}
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="sc-medium"
          style={{ color: "var(--text-primary)", fontSize: 13, flex: 1 }}
        >
          {doc.title}
        </span>
        <span
          style={{
            flexShrink: 0,
            padding: "1px 6px",
            borderRadius: 999,
            background: "var(--info-dim)",
            color: "var(--info-text)",
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}
        </span>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          data-testid={`attached-document-${doc.entityId}-toggle`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide text" : "View text"}
        </button>
      </div>
      {open && (
        <div
          data-testid={`attached-document-${doc.entityId}-text`}
          className="sc-scroll"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 12,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {doc.extractedText.trim().length > 0
            ? doc.extractedText
            : "No extracted text for this document."}
        </div>
      )}
    </div>
  );
}

export function AttachedDocumentsPanel({
  engagementId,
}: {
  engagementId: string;
}) {
  const { data, isLoading } = useListAttachedDocuments(
    engagementId,
    undefined,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListAttachedDocumentsQueryKey(engagementId),
      },
    },
  );

  const docs = data?.attachedDocuments ?? [];

  return (
    <div
      className="sc-card"
      data-testid="attached-documents-panel"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">ATTACHED DOCUMENTS</span>
        <span className="sc-meta" style={{ opacity: 0.7 }}>
          {docs.length} {docs.length === 1 ? "document" : "documents"}
        </span>
      </div>

      {isLoading ? (
        <div
          className="p-4 sc-meta"
          data-testid="attached-documents-loading"
          style={{ color: "var(--text-muted)" }}
        >
          Loading attached documents…
        </div>
      ) : docs.length === 0 ? (
        <div
          className="p-4 sc-meta"
          data-testid="attached-documents-empty"
          style={{ color: "var(--text-muted)" }}
        >
          No supporting documents attached to this engagement. Attached
          documents are produced by the sheet-ingest pipeline.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {docs.map((doc) => (
            <AttachedDocumentRow key={doc.entityId} doc={doc} />
          ))}
        </div>
      )}
    </div>
  );
}
