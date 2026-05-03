/**
 * `AIBadge` — Track 1 / addendum D2.
 *
 * Single rendering convention for finding provenance across the three
 * surfaces that show it: the FindingsTab row, the FindingDrillIn
 * PROVENANCE block, and the comment-letter draft (CommunicateComposer
 * header). Supersedes the older `FindingAuthorTag` (which lived inline
 * in FindingsTab.tsx).
 *
 * Three rendering branches per the addendum, exact strings preserved
 * so e2e selectors stay stable across surfaces:
 *
 *   ai_generated && !accepted_at
 *     → "AI generated"
 *   ai_generated && accepted_at
 *     → "AI generated · reviewer confirmed ({displayName}, {date})"
 *   !ai_generated
 *     → "Authored by reviewer ({displayName})"
 *
 * The aggregate variant is for the comment-letter draft (Q1 resolution)
 * — it renders a single document-level provenance line tied to the
 * letter, NOT a per-finding badge.
 */
import type { FindingActor } from "@workspace/api-client-react";

export type AIBadgeVariant = "row" | "drill-in" | "aggregate";

export interface AIBadgeProps {
  /** True iff the row was produced by the AI compliance-checker. */
  aiGenerated: boolean;
  /** ISO timestamp of when an AI finding was reviewer-accepted. Null until acceptance. */
  acceptedAt?: string | null;
  /** Actor envelope for the reviewer who accepted; preferred over the bare id. */
  acceptedBy?: FindingActor | null;
  /**
   * Actor envelope for the original reviewer-author (used when
   * `aiGenerated === false`). Today this is the existing
   * `reviewerStatusBy` actor — the dispatch addendum names it as
   * the fallback for the original-author lookup.
   */
  reviewerAuthor?: FindingActor | null;
  /** `row` (compact, italic), `drill-in` (slightly larger), `aggregate` (document-level). */
  variant?: AIBadgeVariant;
  /**
   * Aggregate-variant only: the count of source findings the parent
   * letter / surface is summarising. Renders as
   * "AI generated from {count} open findings".
   */
  findingCount?: number;
  /**
   * Aggregate-variant only: the drafting reviewer's display name. Renders
   * as " · drafting reviewer is {name}". Omitted when not provided.
   */
  draftingReviewerName?: string | null;
  "data-testid"?: string;
}

function fallbackName(actor: FindingActor | null | undefined): string {
  if (!actor) return "unknown";
  const trimmed = actor.displayName?.trim();
  if (trimmed) return trimmed;
  return actor.id;
}

function formatAcceptanceDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

function rowStyle(): React.CSSProperties {
  return {
    fontSize: 10,
    color: "var(--text-secondary)",
    fontStyle: "italic",
  };
}

function drillInStyle(): React.CSSProperties {
  return {
    fontSize: 11,
    color: "var(--text-secondary)",
  };
}

function aggregateStyle(): React.CSSProperties {
  return {
    fontSize: 12,
    color: "var(--text-secondary)",
  };
}

function variantStyle(variant: AIBadgeVariant): React.CSSProperties {
  switch (variant) {
    case "drill-in":
      return drillInStyle();
    case "aggregate":
      return aggregateStyle();
    case "row":
    default:
      return rowStyle();
  }
}

export function AIBadge({
  aiGenerated,
  acceptedAt,
  acceptedBy,
  reviewerAuthor,
  variant = "row",
  findingCount,
  draftingReviewerName,
  "data-testid": testId = "ai-badge",
}: AIBadgeProps) {
  const style = variantStyle(variant);

  if (variant === "aggregate") {
    const count = findingCount ?? 0;
    const noun = count === 1 ? "open finding" : "open findings";
    const trailing = draftingReviewerName
      ? ` · drafting reviewer is ${draftingReviewerName}`
      : "";
    return (
      <span
        data-testid={testId}
        data-variant="aggregate"
        data-ai-generated="true"
        style={style}
      >
        {`AI generated from ${count} ${noun}${trailing}`}
      </span>
    );
  }

  let label: string;
  let dataState:
    | "ai-unaccepted"
    | "ai-accepted"
    | "reviewer-authored"
    | undefined;

  if (aiGenerated) {
    if (acceptedAt) {
      const name = fallbackName(acceptedBy);
      const date = formatAcceptanceDate(acceptedAt);
      label = `AI generated · reviewer confirmed (${name}, ${date})`;
      dataState = "ai-accepted";
    } else {
      label = "AI generated";
      dataState = "ai-unaccepted";
    }
  } else {
    const name = fallbackName(reviewerAuthor);
    label = `Authored by reviewer (${name})`;
    dataState = "reviewer-authored";
  }

  return (
    <span
      data-testid={testId}
      data-variant={variant}
      data-state={dataState}
      data-ai-generated={aiGenerated ? "true" : "false"}
      style={style}
    >
      {label}
    </span>
  );
}
