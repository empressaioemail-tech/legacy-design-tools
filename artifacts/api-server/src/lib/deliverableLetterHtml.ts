/**
 * Deliverable-letter HTML renderer for export PDF + print (briefing pattern).
 *
 * Pure-string HTML so unit tests verify layout without Chromium. The
 * read/preview surface in design-tools mirrors this styling.
 */

import type { LetterSection } from "@workspace/atoms-l-surface";

const KIND_ORDER: Record<LetterSection["kind"], number> = {
  cover: 0,
  intro: 1,
  "per-comment-response": 2,
  signature: 99,
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sectionBodyHtml(content: string): string {
  return escapeHtml(content)
    .split(/\r?\n/)
    .map((line) =>
      line.length === 0 ? "<br />" : `<p class="para">${line}</p>`,
    )
    .join("\n");
}

function provenanceFootnote(section: LetterSection, index: number): string {
  const p = section.provenance;
  const parts: string[] = [];
  if (p.findingIds.length > 0) parts.push(`${p.findingIds.length} finding(s)`);
  if (p.responseTaskIds.length > 0) {
    parts.push(`${p.responseTaskIds.length} response task(s)`);
  }
  if (p.sheetContentExtractionIds.length > 0) {
    parts.push(`${p.sheetContentExtractionIds.length} sheet extraction(s)`);
  }
  if (p.adjudicationStateIds.length > 0) {
    parts.push(`${p.adjudicationStateIds.length} adjudication(s)`);
  }
  if (parts.length === 0) return "";
  return `<div class="prov" title="Section ${index + 1} provenance">Sources: ${escapeHtml(parts.join("; "))}</div>`;
}

export interface RenderDeliverableLetterHtmlInput {
  title: string;
  sections: ReadonlyArray<LetterSection>;
  exportedAt?: Date;
}

export function renderDeliverableLetterHtml(
  input: RenderDeliverableLetterHtmlInput,
): string {
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();
  const ordered = [...input.sections].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );

  const body = ordered
    .map((section, i) => {
      const heading =
        section.heading.trim() ||
        section.kind.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const kindClass = `kind-${section.kind.replace(/[^a-z0-9-]/g, "")}`;
      return `<section class="letter-section ${kindClass}">
  <h2 class="section-heading">${escapeHtml(heading)}</h2>
  <div class="section-body">${sectionBodyHtml(section.content)}</div>
  ${provenanceFootnote(section, i)}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    @page { size: letter; margin: 0.75in 0.85in; }
    * { box-sizing: border-box; }
    body {
      font-family: "Times New Roman", Times, serif;
      font-size: 11pt;
      line-height: 1.45;
      color: #1a1a1a;
      margin: 0;
      padding: 0;
    }
    .letter-doc { max-width: 6.5in; margin: 0 auto; }
    .letter-title {
      font-size: 14pt;
      font-weight: 700;
      text-align: center;
      margin: 0 0 1.25rem;
      letter-spacing: 0.02em;
    }
    .letter-section { margin-bottom: 1.1rem; page-break-inside: avoid; }
    .kind-cover .section-heading { font-size: 13pt; text-align: center; border: none; }
    .kind-signature .section-body { margin-top: 1.5rem; }
    .section-heading {
      font-size: 11pt;
      font-weight: 700;
      margin: 0 0 0.35rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #333;
    }
    .section-body .para { margin: 0 0 0.45rem; text-align: justify; }
    .prov {
      font-size: 8pt;
      color: #666;
      margin-top: 0.35rem;
      font-style: italic;
    }
    .export-meta {
      font-size: 8pt;
      color: #888;
      margin-top: 2rem;
      padding-top: 0.5rem;
      border-top: 1px solid #ddd;
    }
  </style>
</head>
<body>
  <article class="letter-doc" data-testid="deliverable-letter-export-doc">
    <h1 class="letter-title">${escapeHtml(input.title)}</h1>
    ${body}
    <div class="export-meta">Exported ${escapeHtml(exportedAt)} — Cortex deliverable letter. Provenance footnotes reflect linked review artifacts; jurisdiction and code disclaimers in section text are authoritative quality-gate language and must not be stripped.</div>
  </article>
</body>
</html>`;
}
