import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type Finding,
  type FindingCitation,
  type FindingSeverity,
} from "@workspace/api-client-react";
import { CodeAtomPill, splitOnCodeAtomTokens } from "./CodeAtomPill";
import { isFindingAddressed, isFindingReviewerPromoted } from "./FindingsList";

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

/**
 * Reviewer-comment marker stamped by the override mutation when the architect
 * uses "Address with next revision". Single source of truth so the
 * reviewer-side timeline can pattern-match it.
 */
export const ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT =
  "Addressed in next revision";

export interface FindingDetailPanelProps {
  finding: Finding | null;
  codeLibraryBase: string;
  onAddressWithRevision: (finding: Finding) => void;
  isAddressing: boolean;
  addressError?: string | null;
  /** Optional retry handler shown alongside an `addressError`. */
  onRetry?: (finding: Finding) => void;
  /** Optional close/clear-selection handler. When provided, pressing Escape
   * dismisses the active finding and a close button appears in the header. */
  onClose?: () => void;
  /**
   * Optional handler invoked when the architect clicks the CAD `elementRef`.
   * When provided, the elementRef renders as a button instead of static text
   * so the parent can swing the BIM viewer to the matching element. The
   * callback receives the raw `elementRef` string (e.g. `door:l2-corridor-9`)
   * — interpretation is the parent's job since this panel ships in
   * `lib/portal-ui` and must stay viewer-agnostic.
   */
  onElementRefClick?: (elementRef: string) => void;
  testIdPrefix?: string;
}

const DEFAULT_TESTID_PREFIX = "architect-finding-detail";

function renderCitation(
  citation: FindingCitation,
  key: number,
  codeLibraryBase: string,
): ReactNode {
  if (citation.kind === "code-section") {
    return (
      <li
        key={key}
        data-testid={`architect-finding-citation-code-${citation.atomId}`}
        style={{ fontSize: 12 }}
      >
        <CodeAtomPill
          atomId={citation.atomId}
          codeLibraryBase={codeLibraryBase}
        />
      </li>
    );
  }
  return (
    <li
      key={key}
      data-testid={`architect-finding-citation-source-${citation.id}`}
      style={{ fontSize: 12 }}
    >
      {citation.label}{" "}
      <span className="sc-meta" style={{ opacity: 0.6 }}>
        ({citation.id})
      </span>
    </li>
  );
}

export function FindingDetailPanel({
  finding,
  codeLibraryBase,
  onAddressWithRevision,
  isAddressing,
  addressError,
  onRetry,
  onClose,
  onElementRefClick,
  testIdPrefix = DEFAULT_TESTID_PREFIX,
}: FindingDetailPanelProps) {
  // Escape key clears the selection when an `onClose` is wired.
  useEffect(() => {
    if (!onClose || !finding) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, finding]);

  // Inline auto-dismissing success indicator shown when the override
  // mutation transitions from in-flight → settled without an error.
  // Mirrors SubmissionRecordedBanner's 8s auto-dismiss pattern so the
  // architect gets a brief, non-blocking confirmation that "Address with
  // next revision" actually landed before the row dims.
  const [showAddressedConfirmation, setShowAddressedConfirmation] =
    useState(false);
  const wasAddressingRef = useRef(false);
  useEffect(() => {
    if (
      wasAddressingRef.current &&
      !isAddressing &&
      !addressError &&
      finding
    ) {
      setShowAddressedConfirmation(true);
    }
    wasAddressingRef.current = isAddressing;
  }, [isAddressing, addressError, finding]);
  // Hide the confirmation when the selection changes so it does not
  // bleed across findings.
  useEffect(() => {
    setShowAddressedConfirmation(false);
  }, [finding?.id]);
  useEffect(() => {
    if (!showAddressedConfirmation) return;
    const t = setTimeout(() => setShowAddressedConfirmation(false), 8000);
    return () => clearTimeout(t);
  }, [showAddressedConfirmation]);

  if (!finding) {
    return (
      <div
        className="sc-card p-6 h-full flex items-center justify-center"
        data-testid={`${testIdPrefix}-empty`}
      >
        <div className="sc-prose opacity-60 text-center">
          Select a finding from the list to see citations and the addressed-
          with-next-revision action.
        </div>
      </div>
    );
  }

  const addressed = isFindingAddressed(finding);
  const promoted = isFindingReviewerPromoted(finding);
  const bodyNodes = splitOnCodeAtomTokens(finding.text, {
    codeLibraryBase,
  });

  return (
    <div
      className="sc-card flex flex-col h-full"
      data-testid={`${testIdPrefix}-${finding.id}`}
      data-addressed={addressed ? "true" : "false"}
    >
      <div className="sc-card-header sc-row-sb">
        <div className="flex items-center gap-2">
          <span
            className="sc-label"
            data-testid={`${testIdPrefix}-severity`}
            style={{ textTransform: "uppercase" }}
          >
            {SEVERITY_LABEL[finding.severity]}
          </span>
          <span className="sc-meta" style={{ opacity: 0.7 }}>
            · {finding.category}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="sc-meta"
            data-testid={`${testIdPrefix}-attribution`}
            style={{ opacity: 0.7 }}
          >
            {promoted ? "Reviewer-promoted" : "AI-produced"}
          </span>
          {onClose && (
            <button
              type="button"
              className="sc-btn-ghost"
              data-testid={`${testIdPrefix}-close`}
              onClick={onClose}
              aria-label="Close finding (Esc)"
              title="Close (Esc)"
              style={{ fontSize: 12, padding: "2px 6px" }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4 flex-1 overflow-y-auto sc-scroll">
        <div
          className="sc-body"
          data-testid={`${testIdPrefix}-body`}
          style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
        >
          {bodyNodes}
        </div>

        {finding.citations.length > 0 && (
          <div data-testid={`${testIdPrefix}-citations`}>
            <div className="sc-label" style={{ marginBottom: 4 }}>
              CITATIONS
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {finding.citations.map((c, i) =>
                renderCitation(c, i, codeLibraryBase),
              )}
            </ul>
          </div>
        )}

        {finding.elementRef && (
          <div data-testid={`${testIdPrefix}-cad-ref`}>
            <div className="sc-label" style={{ marginBottom: 4 }}>
              CAD ELEMENT
            </div>
            {onElementRefClick ? (
              <button
                type="button"
                data-testid={`${testIdPrefix}-cad-ref-link`}
                onClick={() => onElementRefClick(finding.elementRef!)}
                title="Open in 3D viewer"
                className="sc-mono-sm"
                style={{
                  background: "var(--bg-input)",
                  padding: "2px 6px",
                  borderRadius: 3,
                  fontSize: 11,
                  border: "1px solid var(--border-default, transparent)",
                  color: "var(--info-text, inherit)",
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                {finding.elementRef}
              </button>
            ) : (
              <code
                className="sc-mono-sm"
                style={{
                  background: "var(--bg-input)",
                  padding: "2px 6px",
                  borderRadius: 3,
                  fontSize: 11,
                }}
              >
                {finding.elementRef}
              </code>
            )}
          </div>
        )}

        <div
          className="sc-meta"
          data-testid={`${testIdPrefix}-meta`}
          style={{ opacity: 0.7, fontSize: 11 }}
        >
          Generated {finding.aiGeneratedAt}
          {finding.reviewerStatusBy?.displayName
            ? ` · Reviewer: ${finding.reviewerStatusBy.displayName}`
            : ""}
          {finding.reviewerComment
            ? ` · "${finding.reviewerComment}"`
            : ""}
        </div>

        {addressError && (
          <div
            data-testid={`${testIdPrefix}-error`}
            className="alert-block warning"
            style={{
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{addressError}</span>
            {onRetry && (
              <button
                type="button"
                className="sc-btn-sm"
                data-testid={`${testIdPrefix}-retry`}
                disabled={isAddressing}
                onClick={() => onRetry(finding)}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div
        className="sc-card-footer sc-row-sb"
        style={{ padding: "10px 12px" }}
      >
        {showAddressedConfirmation ? (
          <span
            role="status"
            aria-live="polite"
            data-testid={`${testIdPrefix}-addressed-confirmation`}
            className="sc-meta"
            style={{
              fontSize: 11,
              color: "var(--info-text)",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span aria-hidden>✓</span>
            Marked addressed in next revision
          </span>
        ) : (
          <span className="sc-meta" style={{ opacity: 0.6, fontSize: 10 }}>
            {addressed
              ? "This finding has been addressed."
              : "Use the next revision to clear this finding from the list."}
          </span>
        )}
        <button
          type="button"
          className="sc-btn-primary"
          data-testid={`${testIdPrefix}-address-button`}
          disabled={addressed || isAddressing}
          onClick={() => onAddressWithRevision(finding)}
        >
          {addressed
            ? "Addressed"
            : isAddressing
            ? "Addressing…"
            : "Address with next revision"}
        </button>
      </div>
    </div>
  );
}
