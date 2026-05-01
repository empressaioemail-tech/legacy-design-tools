import { useEffect, useState } from "react";
import {
  useOverrideFinding,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
} from "../../lib/findingsApi";

const SEVERITY_OPTIONS: FindingSeverity[] = ["blocker", "concern", "advisory"];
const CATEGORY_OPTIONS: FindingCategory[] = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
];

export interface OverrideFindingModalProps {
  finding: Finding;
  onClose: () => void;
  onOverridden: (revision: Finding) => void;
}

export function OverrideFindingModal({
  finding,
  onClose,
  onOverridden,
}: OverrideFindingModalProps) {
  const [text, setText] = useState(finding.text);
  const [severity, setSeverity] = useState<FindingSeverity>(finding.severity);
  const [category, setCategory] = useState<FindingCategory>(finding.category);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const override = useOverrideFinding(finding.submissionId);

  useEffect(() => {
    setText(finding.text);
    setSeverity(finding.severity);
    setCategory(finding.category);
    setComment("");
    setError(null);
  }, [finding]);

  // Escape closes the modal — same convention as the design-tools
  // submission-detail and submit dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Finding text can't be empty.");
      return;
    }
    try {
      const revision = await override.mutateAsync({
        findingId: finding.id,
        text: trimmed,
        severity,
        category,
        reviewerComment: comment.trim(),
      });
      onOverridden(revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to override finding.");
    }
  };

  return (
    <div
      onClick={onClose}
      data-testid="override-finding-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="sc-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-finding-title"
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="sc-card-header"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div className="flex flex-col gap-1">
            <span
              id="override-finding-title"
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Override finding
            </span>
            <span className="sc-meta opacity-70">
              The original AI finding is preserved for audit.
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            aria-label="Close override modal"
            data-testid="override-finding-close"
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            Close
          </button>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 14 }}>
          <label className="flex flex-col" style={{ gap: 4 }}>
            <span className="sc-label" style={{ fontSize: 11 }}>
              FINDING TEXT
            </span>
            <textarea
              data-testid="override-finding-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              required
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                fontSize: 13,
                color: "var(--text-primary)",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </label>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <label className="flex flex-col" style={{ gap: 4 }}>
              <span className="sc-label" style={{ fontSize: 11 }}>
                SEVERITY
              </span>
              <select
                data-testid="override-finding-severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as FindingSeverity)}
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {FINDING_SEVERITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col" style={{ gap: 4 }}>
              <span className="sc-label" style={{ fontSize: 11 }}>
                CATEGORY
              </span>
              <select
                data-testid="override-finding-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as FindingCategory)}
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {FINDING_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col" style={{ gap: 4 }}>
            <span className="sc-label" style={{ fontSize: 11 }}>
              REVIEWER COMMENT (optional)
            </span>
            <textarea
              data-testid="override-finding-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Why are you overriding this finding?"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                fontSize: 13,
                color: "var(--text-primary)",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </label>

          {error && (
            <div
              role="alert"
              data-testid="override-finding-error"
              style={{
                color: "var(--danger-text)",
                fontSize: 12,
                background: "var(--danger-dim)",
                padding: "6px 8px",
                borderRadius: 4,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 4,
            }}
          >
            <button
              type="button"
              className="sc-btn-ghost"
              onClick={onClose}
              data-testid="override-finding-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sc-btn-primary"
              disabled={override.isPending}
              data-testid="override-finding-submit"
            >
              {override.isPending ? "Saving…" : "Save override"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
