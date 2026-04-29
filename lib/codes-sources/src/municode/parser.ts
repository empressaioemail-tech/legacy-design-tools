/**
 * Pure parser for a Municode CodesContent envelope.
 *
 * Extracted from index.ts so tests can drive it from a captured fixture
 * without invoking the rate-limited client.
 */

import { load } from "cheerio";
import type { AtomCandidate } from "../types";
import { libraryUrl } from "./endpoints";
import type { MunicodeContentEnvelope } from "./client";

export interface MunicodeParseContext {
  /** TOC node id whose children are in this envelope (the "parent" of the docs). */
  parentNodeId: string;
  jobId: number;
  productId: number;
  /** 2-letter state code, used to build canonical library URLs. */
  stateAbbr: string;
  /** library.municode.com URL slug (e.g. "bastrop"). */
  librarySlug: string;
  /** Optional human-readable chapter heading (used as parentSection). */
  chapterHeading?: string;
  /** Fallback URL when state/slug aren't supplied. */
  fallbackUrl: string;
  /** Override timestamp (test stability). */
  fetchedAt?: string;
}

/** Strip HTML tags and collapse whitespace, returning plain text. */
export function htmlToPlainText(html: string): string {
  const $ = load(`<root>${html}</root>`);
  return $("root").text().replace(/\s+/g, " ").trim();
}

/**
 * Promote each Doc with non-null Content (and at least 30 chars of text)
 * into one AtomCandidate. Docs without Content are skipped silently —
 * they're typically TOC stubs.
 */
export function parseSectionResponse(
  env: MunicodeContentEnvelope,
  ctx: MunicodeParseContext,
): AtomCandidate[] {
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const candidates: AtomCandidate[] = [];
  for (const doc of env.Docs ?? []) {
    if (!doc.Content) continue;
    const text = htmlToPlainText(doc.Content);
    if (text.length < 30) continue;
    candidates.push({
      sectionRef: doc.Title,
      sectionTitle: doc.Title,
      parentSection: ctx.chapterHeading ?? null,
      body: text,
      bodyHtml: doc.Content,
      sourceUrl:
        ctx.stateAbbr && ctx.librarySlug
          ? libraryUrl(ctx.stateAbbr, ctx.librarySlug, doc.Id)
          : ctx.fallbackUrl,
      metadata: {
        kind: "municode_doc",
        nodeId: doc.Id,
        parentNodeId: ctx.parentNodeId,
        docOrderId: doc.DocOrderId,
        isAmended: doc.IsAmended,
        isUpdated: doc.IsUpdated,
        jobId: ctx.jobId,
        productId: ctx.productId,
        fetchedAt,
      },
    });
  }
  return candidates;
}
