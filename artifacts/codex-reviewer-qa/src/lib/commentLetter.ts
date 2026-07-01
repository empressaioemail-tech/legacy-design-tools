/**
 * Codex Reviewer QA — comment-letter composition (CDX-9).
 *
 * Pure functions that turn a submission's adjudicated findings into the
 * structured sections of a Cortex L3 `deliverable-letter`. No React, no
 * network — the network wiring lives in `commentLetterApi.ts`, and the
 * letter persists through the existing L3/L6 endpoints (reused, never
 * rebuilt — see the CDX-9 dispatch).
 *
 * Structural commitment 1 (sell reasoning, not data): every
 * per-comment-response section carries the engine's full finding text,
 * the governing code citations, and the confidence score, and its
 * provenance names the exact Codex finding atom it was generated from.
 *
 * Divergence flagged in the CDX-9 `_inbox` report — the Codex reviewer
 * surface has no standalone "adjudication-state atom". CDX-4 records an
 * adjudication as finding-intrinsic state (`status` / `reviewerStatusBy`
 * / `reviewerStatusChangedAt` on the finding atom; an override mints a
 * new finding revision atom). So a section's `findingIds` provenance
 * names the exact adjudicated finding atom — which carries its
 * adjudication inline — and the L3 `adjudicationStateIds` slot is left
 * empty because it has no Codex-side referent.
 */
import type {
  CreateDeliverableLetterSection,
  Finding,
  FindingSeverity,
} from "@workspace/api-client-react";
import {
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  citationLabel,
  formatConfidence,
  resolveFindingConfidence,
  sortFindings,
} from "./findings";

/**
 * A finding is letter-eligible when the reviewer accepted or edited it:
 *   - `accepted` — kept as-is by the reviewer.
 *   - `overridden` with a `revisionOf` — the reviewer-edited revision
 *     row. CDX-4's override mints a new finding atom carrying the edited
 *     text; the superseded original is also stamped `overridden` but has
 *     no `revisionOf`, so this guard excludes it.
 *
 * Rejected, never-adjudicated (`ai-produced`), `promoted-to-architect`,
 * and superseded override originals are all excluded — per the dispatch,
 * "rejected findings are excluded" and only "accepted and edited
 * findings" compose the letter.
 */
export function isLetterEligible(finding: Finding): boolean {
  if (finding.status === "accepted") return true;
  if (finding.status === "overridden" && finding.revisionOf !== null) {
    return true;
  }
  return false;
}

/** Accepted + edited findings for the letter, ordered blockers-first. */
export function letterEligibleFindings(
  findings: ReadonlyArray<Finding>,
): Finding[] {
  return sortFindings(findings.filter(isLetterEligible));
}

/**
 * The finding atom entityIds that fed a per-comment-response section.
 * An edited finding names both the reviewer-revised atom (`id`) and the
 * original AI atom it revised (`revisionOf`), so the audit trail back to
 * the engine's original output stays complete.
 */
export function findingProvenanceIds(finding: Finding): string[] {
  return finding.revisionOf !== null
    ? [finding.id, finding.revisionOf]
    : [finding.id];
}

/** Provenance to merge into one section after the letter is created. */
export interface SectionProvenancePlan {
  /** Zero-based index into the composed `sections` array. */
  sectionIndex: number;
  /** Finding atom entityIds to merge into this section's provenance. */
  findingIds: string[];
}

/** A fully composed comment-letter draft, ready to persist via L3. */
export interface CommentLetterDraft {
  title: string;
  sections: CreateDeliverableLetterSection[];
  /**
   * Per per-comment-response section, the provenance to merge once the
   * letter exists (the L3 create route initializes provenance empty).
   */
  provenancePlan: SectionProvenancePlan[];
}

/** Inputs for {@link composeCommentLetterDraft}. */
export interface ComposeCommentLetterInput {
  engagementName: string;
  jurisdiction: string | null;
  submittedAt: string | null;
  findings: ReadonlyArray<Finding>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not recorded" : d.toLocaleDateString();
}

/**
 * One per-comment-response section body. Carries the engine's reasoning
 * (the finding text), the governing code citations, and the confidence
 * score — never a bare verdict (structural commitment 1).
 */
function composeCommentBody(finding: Finding): string {
  const lines: string[] = [finding.text.trim()];

  const cited =
    finding.citations.length > 0
      ? finding.citations.map(citationLabel).join(", ")
      : "none cited";
  lines.push("", `Code cited: ${cited}`);

  lines.push(
    `Engine confidence: ${formatConfidence(resolveFindingConfidence(finding))}${
      finding.lowConfidence ? " (flagged low confidence)" : ""
    }`,
  );

  if (finding.status === "overridden") {
    lines.push(
      "This comment was revised by the reviewer during adjudication.",
    );
  }
  const reviewerComment = finding.reviewerComment?.trim();
  if (reviewerComment) {
    lines.push(`Reviewer note: ${reviewerComment}`);
  }

  return lines.join("\n");
}

/**
 * Compose a comment letter from a submission's adjudicated findings.
 *
 * Section order is `cover, intro, per-comment-response..., signature`,
 * so the per-comment sections occupy indices `2 .. 2 + N - 1`. The
 * letter is complete by construction (it always carries cover, intro,
 * and signature), so the L6 render is never completeness-blocked.
 */
export function composeCommentLetterDraft(
  input: ComposeCommentLetterInput,
): CommentLetterDraft {
  const eligible = letterEligibleFindings(input.findings);
  const jurisdiction = input.jurisdiction?.trim() || "not recorded";

  const cover: CreateDeliverableLetterSection = {
    kind: "cover",
    heading: "Plan Review Comment Letter",
    content: [
      `Re: Code compliance review — ${input.engagementName}`,
      `Jurisdiction: ${jurisdiction}`,
      `Submission dated ${formatDate(input.submittedAt)}`,
      "",
      "This letter transmits the comments identified during the plan review of the referenced submission.",
    ].join("\n"),
  };

  const counts: Record<FindingSeverity, number> = {
    blocker: 0,
    concern: 0,
    advisory: 0,
  };
  for (const f of eligible) counts[f.severity] += 1;

  const intro: CreateDeliverableLetterSection = {
    kind: "intro",
    heading: "Summary",
    content: [
      `The compliance review produced ${eligible.length} comment${
        eligible.length === 1 ? "" : "s"
      } requiring a response: ${counts.blocker} blocker, ${counts.concern} concern, ${counts.advisory} advisory.`,
      "",
      "Each comment below carries the governing code citation and the engine confidence score it was reviewed against. Comments the reviewer rejected during adjudication are not included.",
    ].join("\n"),
  };

  const perComment: CreateDeliverableLetterSection[] = eligible.map(
    (finding, i) => ({
      kind: "per-comment-response",
      heading: `Comment ${i + 1} — ${CATEGORY_LABELS[finding.category]} (${
        SEVERITY_LABELS[finding.severity]
      })`,
      content: composeCommentBody(finding),
    }),
  );

  const signature: CreateDeliverableLetterSection = {
    kind: "signature",
    heading: "Reviewer",
    content: ["Respectfully,", "", "", "Plan Reviewer", jurisdiction].join(
      "\n",
    ),
  };

  const sections: CreateDeliverableLetterSection[] = [
    cover,
    intro,
    ...perComment,
    signature,
  ];

  const provenancePlan: SectionProvenancePlan[] = eligible.map(
    (finding, i) => ({
      sectionIndex: 2 + i,
      findingIds: findingProvenanceIds(finding),
    }),
  );

  return {
    title: `Comment Letter — ${input.engagementName}`,
    sections,
    provenancePlan,
  };
}
