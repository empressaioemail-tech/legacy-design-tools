/**
 * HTML extraction + edition/section verification for web-code fetch.
 *
 * Verification reads section body in-memory to confirm number + title, then
 * returns only a capped excerpt — never the full verbatim section for persistence.
 */

import { editionYear, sectionPresenceToken } from "./drivers";
import type { WebCodeFetchInput } from "./types";

export interface ExtractionOutcome {
  text: string;
  verified: boolean;
  confidence: number;
  unverifiedWebSource: boolean;
  detectedEditionYear: string | null;
  /** Set when section number/title could not be confirmed on the page. */
  verificationNote?: string;
}

/** Strip tags/scripts and return plain text from HTML (no cheerio dep). */
export function htmlToPlainText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = noScript.replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Verify edition + section number + title against extracted page text.
 * Returns verified:false on wrong edition, missing section, or title mismatch.
 */
export function verifyAndExtract(
  html: string,
  input: WebCodeFetchInput,
): ExtractionOutcome {
  const plain = htmlToPlainText(html);
  const requestedYear = editionYear(input.edition);
  const sectionToken = sectionPresenceToken(input.codeRef);

  const yearMatches = requestedYear
    ? findEditionYearsInText(plain, html)
    : [];
  const detectedEditionYear = yearMatches[0] ?? null;

  let editionOk = true;
  if (requestedYear && yearMatches.length > 0) {
    editionOk = yearMatches.includes(requestedYear);
  }

  if (!editionOk) {
    return {
      text: plain.slice(0, 4000),
      verified: false,
      confidence: 0.25,
      unverifiedWebSource: true,
      detectedEditionYear,
      verificationNote: "wrong-edition",
    };
  }

  const block = extractSectionBlock(plain, sectionToken, input.expectedTitle);
  if (!block) {
    return {
      text: plain.slice(0, 4000),
      verified: false,
      confidence: 0.35,
      unverifiedWebSource: true,
      detectedEditionYear,
      verificationNote: "section-not-found",
    };
  }

  if (!titleMatchesExpected(block.heading, input.expectedTitle)) {
    return {
      text: block.body.slice(0, 4000),
      verified: false,
      confidence: 0.4,
      unverifiedWebSource: true,
      detectedEditionYear,
      verificationNote: "title-mismatch",
    };
  }

  if (block.body.length < 40) {
    return {
      text: block.body,
      verified: false,
      confidence: 0.35,
      unverifiedWebSource: true,
      detectedEditionYear,
      verificationNote: "insufficient-body",
    };
  }

  return {
    text: block.body.slice(0, 1800).trim(),
    verified: true,
    confidence: 0.85,
    unverifiedWebSource: false,
    detectedEditionYear: requestedYear ?? detectedEditionYear,
  };
}

function findEditionYearsInText(plain: string, html: string): string[] {
  const combined = `${plain} ${html}`;
  const years = new Set<string>();
  for (const m of combined.matchAll(/\b(20\d{2})\b/g)) {
    years.add(m[1]!);
  }
  return [...years].sort();
}

export interface SectionBlock {
  heading: string;
  body: string;
}

/** Extract one section's heading + body from a chapter or section page. */
export function extractSectionBlock(
  plain: string,
  sectionToken: string,
  expectedTitle?: string,
): SectionBlock | null {
  const escaped = sectionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** Exact section id — R301.1 must not match R301.1.1 or R301.10. */
  const exactSection = `${escaped}(?!\\.\\d)`;
  const articlePrefix = /^Article\s/i.test(sectionToken) ? "" : "(?:Article\\s+)?";
  const nextSectionBoundary = `(?=\\s+###|\\s+Section\\s+[A-Z]|\\s+${escaped}\\.\\d|$)`;
  const titleEndBoundary =
    "(?=\\s+shall\\b|\\s+is\\b|\\s+are\\b|\\s+###|\\s+Section\\s+[A-Z]|\\s+" +
    `${escaped}\\.\\d|\\s+[A-Z]{1,4}\\d{2,3}(?:\\.\\d+)+\\s+[A-Z]|$)`;
  const titleCapture = `([A-Z][A-Za-z0-9 ,()-]*?${titleEndBoundary})`;
  const headingPatterns = [
    new RegExp(
      `(?:###|Section)\\s+(${exactSection})\\s+${titleCapture}`,
      "i",
    ),
    new RegExp(
      `${articlePrefix}\\b(${exactSection})\\s+${titleCapture}`,
      "i",
    ),
  ];

  let heading = "";
  let bodyStart = -1;

  for (const pattern of headingPatterns) {
    const m = plain.match(pattern);
    if (m) {
      heading = `${m[1]!.trim()} ${m[2]!.trim()}`.trim();
      bodyStart = (m.index ?? 0) + m[0]!.length;
      break;
    }
  }

  if (bodyStart < 0) {
    const loose = new RegExp(
      `${articlePrefix}\\b(${exactSection})\\s+${titleCapture}`,
      "i",
    );
    const hit = loose.exec(plain);
    if (!hit) return null;
    heading = `${hit[1]!.trim()} ${hit[2]!.trim()}`.trim();
    bodyStart = (hit.index ?? 0) + hit[0]!.length;
  }

  if (expectedTitle?.trim()) {
    bodyStart = refineBodyStartWithExpectedTitle(
      plain,
      sectionToken,
      expectedTitle,
      bodyStart,
    );
  }

  const rest = plain.slice(bodyStart);
  const childSection = sectionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextSection = rest.search(
    new RegExp(
      `(?:###|Section)\\s+[A-Z]|\\b${childSection}\\.\\d|\\b[A-Z]{1,4}\\d{2,3}(?:\\.\\d+)+\\s+[A-Z]`,
      "i",
    ),
  );
  const body =
    nextSection >= 0 ? rest.slice(0, nextSection).trim() : rest.trim();

  if (body.length < 20 && heading.length < 10) return null;

  return { heading, body: body || heading };
}

function refineBodyStartWithExpectedTitle(
  plain: string,
  sectionToken: string,
  expectedTitle: string,
  bodyStart: number,
): number {
  const escaped = sectionToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRe = new RegExp(
    `(?:###|Section|Article\\s+)?\\b${escaped}(?!\\.\\d)\\b`,
    "gi",
  );
  let anchor: RegExpExecArray | null = null;
  for (let m = anchorRe.exec(plain); m; m = anchorRe.exec(plain)) {
    if (m.index <= bodyStart + 20) anchor = m;
  }
  if (!anchor) return bodyStart;
  const titleWindow = plain.slice(
    anchor.index + anchor[0]!.length,
    anchor.index + anchor[0]!.length + 160,
  );
  const words = expectedTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  let cursor = 0;
  for (const word of words) {
    const idx = titleWindow.toLowerCase().indexOf(word, cursor);
    if (idx < 0) break;
    cursor = idx + word.length;
  }
  if (cursor > 0) {
    return anchor.index + anchor[0]!.length + cursor;
  }
  return bodyStart;
}

export function titleMatchesExpected(
  heading: string,
  expectedTitle?: string,
): boolean {
  if (!expectedTitle?.trim()) return true;
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const headingNorm = norm(heading);
  const expectedNorm = norm(expectedTitle);
  if (headingNorm.includes(expectedNorm) || expectedNorm.includes(headingNorm)) {
    return true;
  }
  const words = expectedNorm.split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return headingNorm.includes(expectedNorm);
  const primary = words[0]!;
  if (primary.length >= 4 && headingNorm.includes(primary)) return true;
  const hits = words.filter((w) => headingNorm.includes(w)).length;
  return hits >= Math.max(1, Math.ceil(words.length * 0.4));
}
