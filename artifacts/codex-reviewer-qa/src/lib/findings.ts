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
  FindingActor,
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

// ─── CDX-4 — adjudication (accept / edit / reject) ───────────────────

/** Selectable severities, in display order — drives the edit form. */
export const SEVERITY_VALUES: FindingSeverity[] = [
  "blocker",
  "concern",
  "advisory",
];

/** Selectable categories, in display order — drives the edit form. */
export const CATEGORY_VALUES: FindingCategory[] = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
];

/**
 * The editable fields of a finding override (the CDX-4 "edit" action).
 * Mirrors the cortex-api `POST /findings/{id}/override` request body.
 */
export interface OverrideDraft {
  text: string;
  severity: FindingSeverity;
  category: FindingCategory;
  reviewerComment: string;
}

/** Display name for a finding-actor envelope. */
export function actorLabel(actor: FindingActor | null): string {
  return actor?.displayName ?? "a reviewer";
}

/**
 * One-line adjudication summary — e.g. "Accepted by Sam Lee · <when>"
 * — or `null` for an un-adjudicated (`ai-produced`) finding. cortex-api
 * stamps the reviewer attribution + timestamp on every accept / reject
 * / override; this surfaces that audit trail on the card so a CDX-4
 * adjudication is visibly attributed and dated.
 */
export function describeAdjudication(finding: Finding): string | null {
  const when = (value: string | null): string =>
    value ? new Date(value).toLocaleString() : "an unknown time";
  switch (finding.status) {
    case "accepted":
      return `Accepted by ${actorLabel(
        finding.acceptedBy ?? finding.reviewerStatusBy,
      )} · ${when(finding.acceptedAt ?? finding.reviewerStatusChangedAt)}`;
    case "rejected":
      return `Rejected by ${actorLabel(finding.reviewerStatusBy)} · ${when(
        finding.reviewerStatusChangedAt,
      )}`;
    case "overridden":
      return `Overridden by ${actorLabel(finding.reviewerStatusBy)} · ${when(
        finding.reviewerStatusChangedAt,
      )}`;
    case "promoted-to-architect":
      return "Promoted to architect";
    case "ai-produced":
    default:
      return null;
  }
}
