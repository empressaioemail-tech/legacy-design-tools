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

/**
 * Inline citation token grammars the assembler must preserve verbatim
 * across the LLM polish step. The two productions are:
 *
 *   `[[CODE:<atomId>]]`              — the finding-engine code-atom
 *                                       reference.
 *   `{{atom|<entityType>|<entityId>|<label>}}` — the empressa-atom
 *                                       inline reference (kept in
 *                                       sync with `INLINE_ATOM_REGEX`
 *                                       in `@workspace/empressa-atom`).
 *
 * Both regexes are `g`-flagged; callers must reset `lastIndex` before
 * each scan because `extractCitationTokens` does so internally.
 */
const CODE_CITATION_REGEX = /\[\[CODE:[^\]]+\]\]/g;
const ATOM_CITATION_REGEX = /\{\{atom\|[^|]+\|[^|]+\|[^}]+\}\}/g;

/**
 * Extract the multiset of citation tokens (`[[CODE:...]]` and
 * `{{atom|...}}`) from a body so the polish step can verify the LLM
 * didn't drop, mutate, or duplicate any of them. Returned as a sorted
 * count map so equality comparison is order-insensitive (the LLM is
 * free to reorder paragraphs but must keep the same set + counts).
 */
export function extractCitationTokens(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const re of [CODE_CITATION_REGEX, ATOM_CITATION_REGEX]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
    re.lastIndex = 0;
  }
  return counts;
}

function citationCountsEqual(
  a: Map<string, number>,
  b: Map<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [tok, n] of a) {
    if (b.get(tok) !== n) return false;
  }
  return true;
}

/**
 * System prompt seed used by the LLM polish step. Pulled out as a
 * named export so the api-server route can reuse it verbatim and so
 * a downstream prompt-evaluation harness can exercise it without
 * re-implementing the wording.
 */
export const COMMENT_LETTER_POLISH_SYSTEM_PROMPT: string = [
  "You are a senior plan-review code official polishing a draft comment letter that will be sent to the architect of record.",
  "Rewrite the body so it reads as a professional, courteous letter while keeping the same comments, the same severities, and the same factual claims.",
  "You MUST preserve every inline citation token EXACTLY as written, byte-for-byte. The two grammars are `[[CODE:<atomId>]]` and `{{atom|<entityType>|<entityId>|<label>}}`. Do not rename, drop, duplicate, paraphrase, or wrap them in additional markup — they are machine-resolved downstream.",
  "Keep the markdown structure: the `To:` and `Re:` header lines, the `## <Discipline>` and `### <Page label>` section headings, and the bullet list grouping. You may reword bullet text and add bridging sentences inside a section, but every bullet must stay attached to the same heading group it came from and must keep its `**<Severity>**` prefix.",
  "Do not introduce new findings, new code citations, fabricated dates, or commitments the deterministic skeleton did not already make.",
  "Output ONLY the polished markdown letter body. Do not wrap it in a code fence, do not add commentary before or after, and do not include the subject line.",
].join("\n\n");

/**
 * Build the user-message payload for the polish call. Keeps the
 * deterministic skeleton as the single source of truth and surfaces
 * the structured context so the LLM has the metadata it needs (firm
 * name, jurisdiction, submission date) without having to re-derive
 * it from the body.
 */
export function buildCommentLetterPolishUserPrompt(
  skeleton: AssembledCommentLetter,
  context: CommentLetterContext,
): string {
  const addressee = context.applicantFirm ?? "Architect of record";
  return [
    "Polish the following comment-letter draft. Return only the rewritten markdown body.",
    "",
    "## Context",
    `- Addressee: ${addressee}`,
    `- Jurisdiction: ${context.jurisdictionLabel}`,
    `- Submission date: ${context.submittedAt}`,
    `- Open finding count: ${skeleton.findingCount}`,
    "",
    "## Draft body",
    skeleton.body.trimEnd(),
  ].join("\n");
}

/**
 * Caller-supplied LLM completer. Receives the system + user prompts
 * the polish step assembled and resolves to the model's raw text
 * output. Intentionally agnostic of the underlying SDK so the api-
 * server can wire Anthropic in production while tests inject a
 * deterministic stub.
 */
export type CommentLetterPolishCompleter = (args: {
  system: string;
  user: string;
}) => Promise<string>;

export interface PolishedCommentLetter extends AssembledCommentLetter {
  /**
   * Whether the LLM polish actually replaced the deterministic body.
   * False when the polish step was skipped (no open findings) or the
   * citation-preservation guard rejected the model output and the
   * deterministic skeleton was used as the safe fallback.
   */
  polished: boolean;
  /**
   * Reason the deterministic body was kept. Null when `polished` is
   * true. Useful for the caller to log degraded-mode operation.
   */
  fallbackReason:
    | null
    | "no_open_findings"
    | "empty_completion"
    | "missing_citations"
    | "completer_error";
}

function stripWrappingCodeFence(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith("```")) return s;
  // Drop the opening fence (and optional language tag) + the trailing fence.
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) return s;
  const withoutOpen = trimmed.slice(firstNl + 1);
  const closeIdx = withoutOpen.lastIndexOf("```");
  if (closeIdx < 0) return s;
  return withoutOpen.slice(0, closeIdx);
}

/**
 * Run the deterministic skeleton through an LLM polish pass. The
 * function is the single place that owns the citation-preservation
 * guard: if the completer returns text whose `[[CODE:...]]` /
 * `{{atom|...}}` multiset diverges from the skeleton's, the polish
 * is rejected and the deterministic body is returned unchanged so
 * the audit trail can never lose a citation.
 *
 * Skips the polish entirely (and reports `fallbackReason:
 * "no_open_findings"`) when the skeleton has zero open findings —
 * the no-comments letter is a single fixed sentence and not worth
 * a round-trip.
 */
export async function polishCommentLetter(
  input: AssembleCommentLetterInput,
  completer: CommentLetterPolishCompleter,
): Promise<PolishedCommentLetter> {
  const skeleton = assembleCommentLetter(input);
  if (skeleton.findingCount === 0) {
    return { ...skeleton, polished: false, fallbackReason: "no_open_findings" };
  }

  const expected = extractCitationTokens(skeleton.body);
  const user = buildCommentLetterPolishUserPrompt(skeleton, input.context);

  let completion: string;
  try {
    completion = await completer({
      system: COMMENT_LETTER_POLISH_SYSTEM_PROMPT,
      user,
    });
  } catch {
    return { ...skeleton, polished: false, fallbackReason: "completer_error" };
  }

  const cleaned = stripWrappingCodeFence(completion).trim();
  if (cleaned.length === 0) {
    return { ...skeleton, polished: false, fallbackReason: "empty_completion" };
  }

  const got = extractCitationTokens(cleaned);
  if (!citationCountsEqual(expected, got)) {
    return {
      ...skeleton,
      polished: false,
      fallbackReason: "missing_citations",
    };
  }

  // Normalize trailing whitespace the same way the deterministic
  // assembler does so downstream consumers (PDF renderer, email
  // composer) see a single trailing newline regardless of the polish
  // path the body took.
  const polishedBody =
    cleaned.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  return {
    subject: skeleton.subject,
    body: polishedBody,
    findingCount: skeleton.findingCount,
    polished: true,
    fallbackReason: null,
  };
}
