/**
 * Public surface for `@workspace/comment-letter` (PLR-5).
 *
 * Assembles a draft AI comment-letter (markdown) from a submission's
 * open findings, grouped by discipline (`category`) and page label
 * (the BIM `elementRef` when present, otherwise the literal "General")
 * with code-atom citations preserved as inline tokens. Designed to
 * stay deterministic so unit tests can pin the output verbatim — the
 * Anthropic-mode polish is opt-in and additive (it produces an
 * opening paragraph; the body grouping is always template-driven).
 */

import type { FindingCategory, FindingSeverity } from "@workspace/finding-engine";

export type CommentLetterFindingStatus =
  | "ai-produced"
  | "accepted"
  | "rejected"
  | "overridden"
  | "promoted-to-architect";

/**
 * Minimal Finding shape consumed by the assembler. Mirrors the
 * `findings` row columns the template needs and nothing more so a
 * follow-on caller can hydrate from either the wire shape (the FE
 * `Finding` type) or the DB row without an adapter.
 */
export interface CommentLetterFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  status: CommentLetterFindingStatus;
  text: string;
  elementRef: string | null;
}

export interface CommentLetterContext {
  jurisdictionLabel: string;
  applicantFirm: string | null;
  submittedAt: string;
}

export interface AssembleCommentLetterInput {
  findings: ReadonlyArray<CommentLetterFinding>;
  context: CommentLetterContext;
}

export interface AssembledCommentLetter {
  subject: string;
  body: string;
  /** Open-finding count that drove the body. */
  findingCount: number;
}

/**
 * The discipline (category) → reviewer-facing label used in section
 * headers. Centralized so the FE / a future PDF renderer share the
 * same display copy.
 */
export const COMMENT_LETTER_CATEGORY_LABELS: Record<FindingCategory, string> = {
  setback: "Setbacks",
  height: "Height",
  coverage: "Coverage",
  egress: "Egress",
  use: "Use",
  "overlay-conflict": "Overlay conflicts",
  "divergence-related": "Divergence-related",
  other: "Other",
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

/** Severity ordering used to sort findings inside a page-label group. */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  concern: 1,
  advisory: 2,
};

/**
 * Statuses considered "open" — i.e. eligible for inclusion in a
 * comment letter. AI-produced rows the reviewer hasn't acted on are
 * surfaced (the reviewer can edit them out of the draft); explicitly
 * rejected rows and the original side of an override pair are not.
 */
export function isOpenForCommentLetter(
  status: CommentLetterFindingStatus,
): boolean {
  return status === "ai-produced" || status === "accepted";
}

/**
 * Group an open-finding list by `(category, pageLabel)` for the
 * letter body. Page label = `elementRef` when populated, else the
 * literal "General". Returned in deterministic category-enum order
 * with page labels alphabetized within each category.
 */
export function groupFindingsForLetter(
  findings: ReadonlyArray<CommentLetterFinding>,
): Array<{
  category: FindingCategory;
  pages: Array<{ label: string; findings: CommentLetterFinding[] }>;
}> {
  const byCategory = new Map<FindingCategory, Map<string, CommentLetterFinding[]>>();
  for (const f of findings) {
    if (!isOpenForCommentLetter(f.status)) continue;
    const pageLabel = f.elementRef ?? "General";
    let pages = byCategory.get(f.category);
    if (!pages) {
      pages = new Map();
      byCategory.set(f.category, pages);
    }
    let bucket = pages.get(pageLabel);
    if (!bucket) {
      bucket = [];
      pages.set(pageLabel, bucket);
    }
    bucket.push(f);
  }

  // Iterate the category enum in fixed order so output is stable.
  const ordered: Array<{
    category: FindingCategory;
    pages: Array<{ label: string; findings: CommentLetterFinding[] }>;
  }> = [];
  const categoryOrder: FindingCategory[] = [
    "setback",
    "height",
    "coverage",
    "egress",
    "use",
    "overlay-conflict",
    "divergence-related",
    "other",
  ];
  for (const category of categoryOrder) {
    const pages = byCategory.get(category);
    if (!pages || pages.size === 0) continue;
    const pageList = Array.from(pages.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, findings]) => ({
        label,
        findings: [...findings].sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
        ),
      }));
    ordered.push({ category, pages: pageList });
  }
  return ordered;
}

/**
 * Render a single finding as a markdown bullet. The finding `text`
 * is preserved verbatim — inline citation tokens (`[[CODE:<atomId>]]`
 * and `{{atom|briefing-source|...}}`) flow through unchanged so a
 * downstream renderer (PDF, email body) can re-link them.
 */
function renderFindingBullet(f: CommentLetterFinding): string {
  return `- **${SEVERITY_LABEL[f.severity]}** — ${f.text.trim()}`;
}

/**
 * Deterministic markdown assembler. Used directly in mock mode and as
 * the template the Anthropic polish step seeds from in live mode.
 */
export function assembleCommentLetter(
  input: AssembleCommentLetterInput,
): AssembledCommentLetter {
  const open = input.findings.filter((f) => isOpenForCommentLetter(f.status));
  const grouped = groupFindingsForLetter(open);
  const lines: string[] = [];

  const addressee = input.context.applicantFirm ?? "Architect of record";
  lines.push(`To: ${addressee}`);
  lines.push(`Re: Plan-review submission (${input.context.jurisdictionLabel})`);
  lines.push("");
  if (open.length === 0) {
    lines.push(
      "We have completed our review of the referenced submission and have no open comments at this time.",
    );
  } else {
    const noun = open.length === 1 ? "comment" : "comments";
    lines.push(
      `We have completed our review of the referenced submission. The following ${open.length} ${noun} require your attention before we can advance the application:`,
    );
    lines.push("");
    for (const group of grouped) {
      lines.push(`## ${COMMENT_LETTER_CATEGORY_LABELS[group.category]}`);
      for (const page of group.pages) {
        lines.push(`### ${page.label}`);
        for (const f of page.findings) {
          lines.push(renderFindingBullet(f));
        }
        lines.push("");
      }
    }
    lines.push(
      "Please respond with a revised submission addressing each comment above.",
    );
  }

  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  const subject = `Plan review comments — ${input.context.jurisdictionLabel}`;
  return { subject, body, findingCount: open.length };
}
