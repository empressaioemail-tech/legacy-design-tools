import { Fragment, useState } from "react";
import { Box } from "lucide-react";
import {
  useAcceptFinding,
  useListSubmissionFindings,
  useRejectFinding,
  type Finding,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
} from "../../lib/findingsApi";
import {
  CodeAtomPill,
  SourceCitationPill,
  renderFindingBody,
} from "./CodeAtomPill";
import { SEVERITY_PALETTE, STATUS_PALETTE } from "./severityStyles";
import { OverrideFindingModal } from "./OverrideFindingModal";

export interface FindingDrillInProps {
  finding: Finding;
  onClose: () => void;
  onAfterMutate?: (next: Finding) => void;
  onShowInViewer?: (elementRef: string) => void;
  /** When false, hides Accept / Reject / Override mutation buttons. */
  isReviewer?: boolean;
}

export function FindingDrillIn({
  finding,
  onClose,
  onAfterMutate,
  onShowInViewer,
  isReviewer = true,
}: FindingDrillInProps) {
  const [overrideOpen, setOverrideOpen] = useState(false);

  const accept = useAcceptFinding(finding.submissionId);
  const reject = useRejectFinding(finding.submissionId);

  const palette = SEVERITY_PALETTE[finding.severity];
  const statusPalette = STATUS_PALETTE[finding.status];

  const handleAccept = async () => {
    const next = await accept.mutateAsync({ findingId: finding.id });
    onAfterMutate?.(next);
  };
  const handleReject = async () => {
    const next = await reject.mutateAsync({ findingId: finding.id });
    onAfterMutate?.(next);
  };

  const viewerJumpEnabled =
    finding.elementRef !== null && typeof onShowInViewer === "function";
  const handleViewerJump = () => {
    if (!viewerJumpEnabled || finding.elementRef === null) return;
    onShowInViewer?.(finding.elementRef);
  };

  const submissionFindings = useListSubmissionFindings(finding.submissionId);
  const originalAi = finding.revisionOf
    ? (submissionFindings.data ?? []).find(
        (f) => f.id === finding.revisionOf,
      ) ?? null
    : null;
  const [seeOriginalOpen, setSeeOriginalOpen] = useState(false);

  return (
    <aside
      data-testid={`finding-drill-in-${finding.id}`}
      style={{
        width: "100%",
        maxWidth: 480,
        borderLeft: "1px solid var(--border-default)",
        background: "var(--bg-input)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        className="sc-card-header"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-default)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span
              data-testid={`finding-drill-in-severity-${finding.severity}`}
              style={{
                background: palette.bg,
                color: palette.fg,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
              }}
            >
              {FINDING_SEVERITY_LABELS[finding.severity]}
            </span>
            <span
              style={{
                background: "var(--bg-default)",
                border: "1px solid var(--border-default)",
                color: "var(--text-secondary)",
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 3,
              }}
            >
              {FINDING_CATEGORY_LABELS[finding.category]}
            </span>
            <span
              data-testid={`finding-drill-in-status-${finding.status}`}
              style={{
                background: statusPalette.bg,
                color: statusPalette.fg,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "1px 6px",
                borderRadius: 999,
              }}
            >
              {FINDING_STATUS_LABELS[finding.status]}
            </span>
            {finding.lowConfidence && (
              <span
                data-testid="finding-drill-in-low-confidence"
                title={`Model confidence ${(finding.confidence * 100).toFixed(0)}%`}
                style={{
                  background: "var(--warning-dim)",
                  color: "var(--warning-text)",
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                Low confidence
              </span>
            )}
          </div>
          <span
            className="sc-meta opacity-70"
            style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}
          >
            {finding.id}
          </span>
        </div>
        <button
          type="button"
          className="sc-btn-ghost"
          onClick={onClose}
          aria-label="Close finding drill-in"
          data-testid="finding-drill-in-close"
          style={{ padding: "2px 8px", fontSize: 12 }}
        >
          Close
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "14px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Section label="FINDING">
          <div
            data-testid="finding-drill-in-text"
            style={{
              color: "var(--text-primary)",
              fontSize: 13,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
            }}
          >
            {renderFindingBody(finding.text).map((node, i) => (
              <Fragment key={i}>{node}</Fragment>
            ))}
          </div>
          {finding.reviewerComment && (
            <div
              data-testid="finding-drill-in-reviewer-comment"
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "var(--text-primary)",
                background: "var(--bg-default)",
                padding: 8,
                borderRadius: 4,
                borderLeft: "2px solid var(--border-active)",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                className="sc-label"
                style={{ fontSize: 10, marginBottom: 4 }}
              >
                REVIEWER COMMENT
              </div>
              {finding.reviewerComment}
            </div>
          )}
        </Section>

        <Section label="CITATIONS">
          {finding.citations.length === 0 ? (
            <div className="sc-body opacity-60" style={{ fontSize: 12 }}>
              No citations attached to this finding.
            </div>
          ) : (
            <ul
              data-testid="finding-drill-in-citations"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {finding.citations.map((c, i) => (
                <li
                  key={`${c.kind}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  {c.kind === "code-section" ? (
                    <CodeAtomPill atomId={c.atomId} />
                  ) : (
                    <SourceCitationPill sourceId={c.id} label={c.label} />
                  )}
                  <span style={{ color: "var(--text-secondary)" }}>
                    {c.kind === "code-section"
                      ? "Code section"
                      : "Briefing source"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(finding.elementRef || finding.sourceRef) && (
          <Section label="REFERENCES">
            {finding.elementRef && (
              <div
                data-testid="finding-drill-in-element-ref"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    background: "var(--bg-default)",
                    border: "1px solid var(--border-default)",
                    padding: "2px 6px",
                    borderRadius: 3,
                    fontFamily: "ui-monospace, monospace",
                    color: "var(--text-primary)",
                  }}
                >
                  {finding.elementRef}
                </span>
                <button
                  type="button"
                  className="sc-btn-sm"
                  onClick={handleViewerJump}
                  disabled={!viewerJumpEnabled}
                  data-testid="finding-drill-in-viewer-jump"
                  data-viewer-attached={
                    typeof onShowInViewer === "function" ? "true" : "false"
                  }
                  aria-label={`Show ${finding.elementRef} in the BIM Model tab`}
                  title={
                    viewerJumpEnabled
                      ? `Open ${finding.elementRef} in the BIM Model tab`
                      : "3D viewer not attached to this drill-in"
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    fontSize: 11,
                  }}
                >
                  <Box size={11} aria-hidden />
                  Show in 3D viewer
                </button>
              </div>
            )}
            {finding.sourceRef && (
              <div
                data-testid="finding-drill-in-source-ref"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  marginTop: 6,
                }}
              >
                <SourceCitationPill
                  sourceId={finding.sourceRef.id}
                  label={finding.sourceRef.label}
                />
                <span style={{ color: "var(--text-secondary)" }}>
                  Backing briefing source
                </span>
              </div>
            )}
          </Section>
        )}

        {originalAi && (
          <Section label="HISTORY">
            <button
              type="button"
              data-testid="finding-drill-in-see-original"
              className="sc-btn-sm"
              onClick={() => setSeeOriginalOpen((v) => !v)}
              aria-expanded={seeOriginalOpen}
              style={{ alignSelf: "flex-start", fontSize: 11 }}
            >
              {seeOriginalOpen ? "Hide AI's original" : "See AI's original"}
            </button>
            {seeOriginalOpen && (
              <div
                data-testid="finding-drill-in-original-text"
                style={{
                  marginTop: 8,
                  background: "var(--bg-default)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.55,
                }}
              >
                {renderFindingBody(originalAi.text).map((node, i) => (
                  <Fragment key={i}>{node}</Fragment>
                ))}
              </div>
            )}
          </Section>
        )}

        <Section label="PROVENANCE">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
            <div>AI generated: {new Date(finding.aiGeneratedAt).toLocaleString()}</div>
            <div>
              Confidence: {(finding.confidence * 100).toFixed(0)}%
              {finding.lowConfidence ? " (low)" : ""}
            </div>
            {finding.reviewerStatusBy && finding.reviewerStatusChangedAt && (
              <div>
                Reviewer status by{" "}
                {finding.reviewerStatusBy.displayName ?? finding.reviewerStatusBy.id}{" "}
                at {new Date(finding.reviewerStatusChangedAt).toLocaleString()}
              </div>
            )}
          </div>
        </Section>
      </div>

      {isReviewer && (
        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border-default)",
            background: "var(--bg-default)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={handleReject}
            disabled={reject.isPending || finding.status === "rejected"}
            data-testid="finding-drill-in-reject"
          >
            Reject
          </button>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={() => setOverrideOpen(true)}
            data-testid="finding-drill-in-override"
          >
            Override
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={handleAccept}
            disabled={accept.isPending || finding.status === "accepted"}
            data-testid="finding-drill-in-accept"
          >
            {accept.isPending ? "Accepting…" : "Accept"}
          </button>
        </div>
      )}

      {overrideOpen && (
        <OverrideFindingModal
          finding={finding}
          onClose={() => setOverrideOpen(false)}
          onOverridden={(rev) => {
            setOverrideOpen(false);
            onAfterMutate?.(rev);
          }}
        />
      )}
    </aside>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        className="sc-label"
        style={{
          fontSize: 11,
          letterSpacing: "0.05em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          background: "var(--bg-default)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {children}
      </div>
    </div>
  );
}
