import { type Finding, type FindingSeverity } from "@workspace/api-client-react";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  concern: 1,
  advisory: 2,
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

const SEVERITY_PILL_STYLE: Record<
  FindingSeverity,
  { background: string; color: string; border: string }
> = {
  blocker: {
    background: "rgba(239, 68, 68, 0.18)",
    color: "#ef4444",
    border: "1px solid rgba(239, 68, 68, 0.4)",
  },
  concern: {
    background: "rgba(245, 158, 11, 0.18)",
    color: "#f59e0b",
    border: "1px solid rgba(245, 158, 11, 0.4)",
  },
  advisory: {
    background: "rgba(0, 180, 216, 0.15)",
    color: "var(--cyan)",
    border: "1px solid rgba(0, 180, 216, 0.35)",
  },
};

export function isFindingAddressed(finding: Finding): boolean {
  return finding.status === "overridden";
}

export function isFindingReviewerPromoted(finding: Finding): boolean {
  if (finding.status === "promoted-to-architect") return true;
  if (finding.reviewerStatusBy && finding.reviewerStatusBy.kind === "user") {
    return true;
  }
  return finding.revisionOf !== null;
}

/**
 * Triage order: unaddressed first, addressed sink to the bottom; within each
 * group sort by severity bucket (blocker > concern > advisory) then oldest
 * `aiGeneratedAt` first.
 */
export function compareFindings(a: Finding, b: Finding): number {
  const addressedDelta =
    Number(isFindingAddressed(a)) - Number(isFindingAddressed(b));
  if (addressedDelta !== 0) return addressedDelta;
  const bucketDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bucketDelta !== 0) return bucketDelta;
  const aTs = Date.parse(a.aiGeneratedAt);
  const bTs = Date.parse(b.aiGeneratedAt);
  if (Number.isNaN(aTs) || Number.isNaN(bTs)) return 0;
  return aTs - bTs;
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

export function countUnaddressedFindings(findings: readonly Finding[]): number {
  let n = 0;
  for (const f of findings) if (!isFindingAddressed(f)) n++;
  return n;
}

export interface FindingsListProps {
  findings: readonly Finding[];
  selectedFindingId: string | null;
  onSelect: (findingId: string) => void;
  testIdPrefix?: string;
}

const DEFAULT_ROW_TESTID_PREFIX = "architect-findings-row";

export function FindingsList({
  findings,
  selectedFindingId,
  onSelect,
  testIdPrefix = DEFAULT_ROW_TESTID_PREFIX,
}: FindingsListProps) {
  const sorted = sortFindings(findings);
  return (
    <div
      className="flex flex-col"
      data-testid="architect-findings-list"
      role="list"
    >
      {sorted.map((finding) => {
        const addressed = isFindingAddressed(finding);
        const promoted = isFindingReviewerPromoted(finding);
        const selected = selectedFindingId === finding.id;
        const pillStyle = SEVERITY_PILL_STYLE[finding.severity];
        return (
          <button
            type="button"
            key={finding.id}
            role="listitem"
            data-testid={`${testIdPrefix}-${finding.id}`}
            data-selected={selected ? "true" : "false"}
            data-addressed={addressed ? "true" : "false"}
            data-reviewer-promoted={promoted ? "true" : "false"}
            data-severity={finding.severity}
            onClick={() => onSelect(finding.id)}
            style={{
              textAlign: "left",
              width: "100%",
              border: "none",
              background: selected ? "var(--bg-highlight)" : "transparent",
              borderBottom: "1px solid var(--border-default)",
              borderLeft: selected
                ? "3px solid var(--cyan)"
                : "3px solid transparent",
              padding: "10px 12px",
              cursor: "pointer",
              opacity: addressed ? 0.55 : 1,
              fontFamily: "inherit",
              color: "inherit",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="sc-pill"
                style={{
                  ...pillStyle,
                  fontSize: 10,
                  letterSpacing: "0.05em",
                  padding: "2px 6px",
                  borderRadius: 3,
                  textTransform: "uppercase",
                }}
                data-testid={`${testIdPrefix}-${finding.id}-severity`}
              >
                {SEVERITY_LABEL[finding.severity]}
              </span>
              <span
                className="sc-meta"
                style={{ opacity: 0.7, fontSize: 10 }}
                data-testid={`${testIdPrefix}-${finding.id}-attribution`}
              >
                {promoted ? "Reviewer" : "AI"}
              </span>
            </div>
            <div
              className="sc-body"
              style={{
                fontSize: 12.5,
                lineHeight: 1.4,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {finding.text}
            </div>
            <div
              className="sc-meta"
              style={{
                fontSize: 10,
                opacity: 0.6,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span style={{ textTransform: "uppercase" }}>
                {finding.category}
              </span>
              {addressed && (
                <span
                  data-testid={`${testIdPrefix}-${finding.id}-addressed-tag`}
                  style={{ color: "var(--cyan)" }}
                >
                  · Addressed
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
