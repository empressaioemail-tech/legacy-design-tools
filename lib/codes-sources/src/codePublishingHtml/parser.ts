/**
 * Pure parser for one Code Publishing Co. article HTML page.
 *
 * Atomization is locked at the H3 ("section") level. H4 subsections fold
 * into the parent H3's body as `[label]` markers. Sections larger than
 * {@link MAX_CHARS_PER_CHUNK} are split into `…#partN` siblings with a
 * parallel suffix on the title. Per-section `<span class="revised">`
 * markers are stripped from the title and stored in atom
 * `metadata.revision`.
 */

import { type CheerioAPI, load, type Cheerio } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { AtomCandidate } from "../types";

/** Hard cap per chunk for embedding model context safety. Mirrors grandCountyPdf. */
export const MAX_CHARS_PER_CHUNK = 4000;

export interface ParsedArticle {
  /** Article-level number from the H1 (e.g., "2" for "Article 2 Zoning Districts"). */
  articleNumber: string | null;
  /** Article-level title from the H1 (e.g., "Zoning Districts"). */
  articleTitle: string | null;
  /** Article-level revision marker from the H1's `.revised` span(s), if any. */
  articleRevision: string | null;
}

function squish(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Parse the H1 to extract the article number, plain-text title, and revision
 * marker (if any). Returns nulls when the page lacks an `<h1 class="Title">`.
 */
function parseArticleHeader($: CheerioAPI): ParsedArticle {
  const h1 = $("h1.Title").first();
  if (h1.length === 0) {
    return { articleNumber: null, articleTitle: null, articleRevision: null };
  }
  const revision = extractRevision($, h1);
  // Clone, strip revision spans, then read text.
  const clone = h1.clone();
  clone.find("span.revised").remove();
  const text = squish(clone.text());
  // Typical shape: "Article 2 Zoning Districts" — peel "Article" + number off
  // the front so we can store them separately.
  const m = /^Article\s+([0-9A-Za-z]+)\s+(.+)$/.exec(text);
  if (m) {
    return {
      articleNumber: m[1],
      articleTitle: m[2].trim(),
      articleRevision: revision,
    };
  }
  return { articleNumber: null, articleTitle: text || null, articleRevision: revision };
}

/**
 * Read all `<span class="revised">` text inside an element, drop the leading
 * "Revised " token, and join multiple markers with " / ". Returns null when
 * no revision span is present.
 */
function extractRevision(
  $: CheerioAPI,
  el: Cheerio<AnyNode>,
): string | null {
  const parts: string[] = [];
  el.find("span.revised").each((_i, node) => {
    const t = squish($(node).text()).replace(/^Revised\s+/i, "");
    if (t) parts.push(t);
  });
  if (parts.length === 0) return null;
  return parts.join(" / ");
}

interface RawSection {
  ref: string;
  title: string;
  parentRef: string | null;
  revision: string | null;
  /** Concatenated plain-text body, with H4 subheadings inlined. */
  body: string;
  /** Raw HTML between this H3 and the next H3 (or end of container). */
  bodyHtml: string;
}

/**
 * Walk the DOM in document order, anchored on `<h3 class="Cite">`. Each H3
 * begins a new section; everything between this H3 and the next H3 (across
 * sibling boundaries) folds into the H3's body. H4 headings within that
 * range are flattened into the body text as bracketed labels so they remain
 * searchable but don't fragment the atom.
 *
 * Returns sections in source order. Empty body is allowed — the caller may
 * still want a stub atom for a section that is just a heading.
 */
function collectSections(
  $: CheerioAPI,
  article: ParsedArticle,
): RawSection[] {
  const out: RawSection[] = [];
  const h3s = $("h3.Cite").toArray();

  for (let i = 0; i < h3s.length; i++) {
    const h3 = $(h3s[i]);
    const ref = (h3.attr("id") ?? "").trim();
    if (!ref) continue;
    const revision = extractRevision($, h3);
    const titleClone = h3.clone();
    titleClone.find("span.revised").remove();
    // Drop the leading "N.X" number from the title text so callers don't
    // get duplication when they format `${ref} ${title}`.
    const fullTitle = squish(titleClone.text());
    const titleNoRef = fullTitle
      .replace(new RegExp(`^${ref.replace(/[.()]/g, "\\$&")}\\s*`), "")
      .trim();

    const { bodyText, bodyHtml } = walkUntilNextH3($, h3s[i], h3s[i + 1]);

    out.push({
      ref,
      title: titleNoRef || fullTitle,
      parentRef: article.articleNumber,
      revision,
      body: bodyText,
      bodyHtml,
    });
  }
  return out;
}

/**
 * Collect all DOM nodes (in document order) strictly between `start` and the
 * optional `end` boundary, returning concatenated plain text and raw HTML.
 * Walks the post-order document stream to be robust against nested DIV
 * wrappers around H3/H4/P/TABLE siblings.
 */
function walkUntilNextH3(
  $: CheerioAPI,
  start: Element,
  end: Element | undefined,
): { bodyText: string; bodyHtml: string } {
  const root = $.root();
  const all = root.find("*").toArray();
  const startIdx = all.indexOf(start);
  const endIdx = end ? all.indexOf(end) : -1;
  if (startIdx === -1) return { bodyText: "", bodyHtml: "" };

  const sliceEnd = endIdx === -1 ? all.length : endIdx;
  const between: Element[] = [];
  for (let i = startIdx + 1; i < sliceEnd; i++) {
    const node = all[i];
    // Skip descendants of the start H3 itself (e.g. inline <a> or
    // <span class="revised"> children) — those belong to the heading,
    // not the body — and skip descendants of nodes already collected so
    // we only retain top-level content nodes between H3 boundaries.
    if (isDescendant($, node, start)) continue;
    if (between.some((parent) => isDescendant($, node, parent))) continue;
    between.push(node);
  }

  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const node of between) {
    const $n = $(node);
    if ($n.is("h4")) {
      // Inline H4 as a bracketed label so the search index keeps the
      // subsection name without splitting the atom.
      const headingClone = $n.clone();
      headingClone.find("span.revised").remove();
      const heading = squish(headingClone.text());
      if (heading) textParts.push(`[${heading}]`);
    } else {
      const text = squish($n.text());
      if (text) textParts.push(text);
    }
    htmlParts.push($.html(node));
  }
  return {
    bodyText: textParts.join("\n").trim(),
    bodyHtml: htmlParts.join(""),
  };
}

function isDescendant(
  $: CheerioAPI,
  node: Element,
  ancestor: Element,
): boolean {
  return $(node).parents().toArray().includes(ancestor);
}

/**
 * Split an over-cap section into `…#partN` siblings with a parallel suffix on
 * the title. Mirrors the IWUIC PDF parser's `MAX_CHARS_PER_CHUNK` heuristic.
 */
function splitOverCap(
  ref: string,
  title: string,
  body: string,
): Array<{ ref: string; title: string; body: string }> {
  if (body.length <= MAX_CHARS_PER_CHUNK) {
    return [{ ref, title, body }];
  }
  const parts: Array<{ ref: string; title: string; body: string }> = [];
  let i = 0;
  let part = 1;
  while (i < body.length) {
    parts.push({
      ref: `${ref}#part${part}`,
      title: `${title} (part ${part})`,
      body: body.slice(i, i + MAX_CHARS_PER_CHUNK),
    });
    i += MAX_CHARS_PER_CHUNK;
    part += 1;
  }
  return parts;
}

export interface ParseArticleOptions {
  /** Stable URL of the article page; appended with `#<sectionRef>` per atom. */
  sourceUrl: string;
  /** Override timestamp (test stability). */
  scrapedAt?: string;
}

/**
 * Parse one full article HTML page into AtomCandidates at H3 (section)
 * granularity, splitting any section larger than {@link MAX_CHARS_PER_CHUNK}
 * into `#partN` children. H4 subsections fold into the parent H3's body.
 *
 * Returns an empty array (does NOT throw) when the page has no H3 sections —
 * the LUCAddA/LUCAddB appendix pages are 2 KB stubs with zero H3s and the
 * Phase 1 recon explicitly de-scoped them; failing loud would block warmup
 * for the whole jurisdiction over content that was always going to be empty.
 */
export function parseCodePublishingArticle(
  html: string,
  opts: ParseArticleOptions,
): AtomCandidate[] {
  const $ = load(html);
  const article = parseArticleHeader($);
  const sections = collectSections($, article);
  const scrapedAt = opts.scrapedAt ?? new Date().toISOString();

  const candidates: AtomCandidate[] = [];
  for (const sec of sections) {
    const split = splitOverCap(sec.ref, sec.title, sec.body);
    const isSplit = split.length > 1;
    for (let i = 0; i < split.length; i++) {
      const part = split[i];
      candidates.push({
        sectionRef: part.ref,
        sectionTitle: part.title,
        parentSection: sec.parentRef,
        body: part.body,
        // Only attach bodyHtml on the un-split atom; once we slice mid-DOM
        // the HTML stops being well-formed, which the orchestrator persists
        // verbatim.
        bodyHtml: isSplit ? null : sec.bodyHtml || null,
        sourceUrl: `${opts.sourceUrl}#${sec.ref}`,
        metadata: {
          kind: "code_publishing_section",
          articleNumber: article.articleNumber,
          articleTitle: article.articleTitle,
          articleRevision: article.articleRevision,
          revision: sec.revision,
          isSplit,
          partIndex: isSplit ? i + 1 : null,
          partTotal: isSplit ? split.length : null,
          chunkBytes: part.body.length,
          scrapedAt,
        },
      });
    }
  }
  return candidates;
}
