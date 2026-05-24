import { useEffect } from "react";
import {
  useGetCodeAtom,
  getGetCodeAtomQueryKey,
} from "@workspace/api-client-react";

export interface CodeAtomDetailModalProps {
  atomId: string;
  onClose: () => void;
  /** Optional link to the full Code Library page for this atom. */
  codeLibraryHref?: string;
}

export function CodeAtomDetailModal({
  atomId,
  onClose,
  codeLibraryHref,
}: CodeAtomDetailModalProps) {
  const { data, isLoading, isError } = useGetCodeAtom(atomId, {
    query: {
      enabled: !!atomId,
      queryKey: getGetCodeAtomQueryKey(atomId),
    },
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Code section detail"
      data-testid="code-atom-detail-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 200,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 780,
          width: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header sc-row-sb">
          <span className="sc-label">CODE SECTION</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {codeLibraryHref ? (
              <a
                href={codeLibraryHref}
                className="sc-btn-ghost sc-btn-sm"
                data-testid="code-atom-detail-open-library"
                style={{ fontSize: 11 }}
              >
                Open in library
              </a>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="sc-btn-sm"
              data-testid="code-atom-detail-close"
              aria-label="Close code section detail"
            >
              Close
            </button>
          </div>
        </div>
        <div
          style={{ overflowY: "auto", padding: 16 }}
          data-testid="code-atom-detail-body"
        >
          {isLoading ? (
            <div className="sc-body" data-testid="code-atom-detail-loading">
              Loading code section…
            </div>
          ) : isError || !data ? (
            <div
              className="sc-body"
              data-testid="code-atom-detail-error"
              style={{ color: "var(--danger-text, #f87171)" }}
            >
              Couldn&apos;t load this code section.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="sc-mono-sm sc-medium">
                  {data.sectionNumber ?? "—"}
                </div>
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    margin: "4px 0 0",
                    color: "var(--text-primary)",
                  }}
                >
                  {data.sectionTitle ?? "(untitled)"}
                </h3>
                <div className="sc-mono-sm sc-meta" style={{ marginTop: 4 }}>
                  {data.codeBook} · {data.edition} · {data.sourceName}
                </div>
                {data.sourceUrl ? (
                  <a
                    className="sc-link sc-mono-sm"
                    href={data.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="code-atom-detail-source-link"
                    style={{ display: "inline-block", marginTop: 8 }}
                  >
                    Open source ↗
                  </a>
                ) : null}
              </div>
              <pre
                data-testid="code-atom-detail-content"
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: 12,
                }}
              >
                {data.body}
              </pre>
              <div className="sc-mono-sm sc-meta" style={{ opacity: 0.6 }}>
                atom id: {data.id}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
