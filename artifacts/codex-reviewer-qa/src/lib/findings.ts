/**
 * Codex Reviewer QA — finding presentation helpers (CDX-3).
 *
 * Pure label maps + formatters over the `Finding` wire shape from
 * `@workspace/api-client-react`. No React, no network — kept separate
 * from `FindingCard` so the formatting rules are unit-testable on
 * their own.
 */
import type {
  Finding,
  FindingCategory,
  FindingCitation,
  FindingSeverity,
  FindingStatus,
} from "@workspace/api-client-react";

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

/** Sort weight — blockers first. */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  concern: 1,
  advisory: 2,
};

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  setback: "Setback",
  height: "Height",
  coverage: "Coverage",
  egress: "Egress",
  use: "Use",
  "overlay-conflict": "Overlay conflict",
  "divergence-related": "Divergence-related",
  other: "Other",
};

export const STATUS_LABELS: Record<FindingStatus, string> = {
  "ai-produced": "AI-produced",
  accepted: "Accepted",
  rejected: "Rejected",
  overridden: "Overridden",
  "promoted-to-architect": "Promoted to architect",
};

/** Format a 0–1 engine confidence score as a whole-percent string. */
export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Human-readable label for one finding citation. Code-section
 * citations carry only an opaque atom id; briefing-source citations
 * carry a server-provided label.
 */
export function citationLabel(citation: FindingCitation): string {
  return citation.kind === "code-section" ? citation.atomId : citation.label;
}

/**
 * Order findings for review — blockers first, then most-recently
 * generated. Returns a new array; does not mutate the input.
 */
export function sortFindings(findings: ReadonlyArray<Finding>): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.aiGeneratedAt.localeCompare(a.aiGeneratedAt);
  });
}
