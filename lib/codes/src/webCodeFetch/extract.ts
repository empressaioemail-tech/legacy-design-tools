/**
 * HTML extraction + edition/section verification for web-code fetch.
 */

import { editionYear, sectionPresenceToken } from "./drivers";
import type { WebCodeFetchInput } from "./types";

export interface ExtractionOutcome {
  text: string;
  verified: boolean;
  confidence: number;
  unverifiedWebSource: boolean;
  detectedEditionYear: string | null;
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
 * Verify edition + section against extracted page text.
 * Returns verified:false on wrong edition (e.g. FBC 2020 vs 2023).
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

  const sectionOk =
    plain.toLowerCase().includes(sectionToken.toLowerCase()) ||
    plain.toLowerCase().includes(input.codeRef.toLowerCase());

  const textLen = plain.length;
  const hasSubstance = textLen >= 120;

  if (!editionOk) {
    return {
      text: plain.slice(0, 4000),
      verified: false,
      confidence: 0.25,
      unverifiedWebSource: true,
      detectedEditionYear,
    };
  }

  if (!sectionOk || !hasSubstance) {
    return {
      text: plain.slice(0, 4000),
      verified: false,
      confidence: 0.35,
      unverifiedWebSource: true,
      detectedEditionYear,
    };
  }

  const excerpt = extractSectionExcerpt(plain, input.codeRef);
  return {
    text: excerpt,
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
    years.add(m[1]);
  }
  return [...years].sort();
}

function extractSectionExcerpt(plain: string, codeRef: string): string {
  const token = sectionPresenceToken(codeRef);
  const idx = plain.toLowerCase().indexOf(token.toLowerCase());
  if (idx < 0) {
    return plain.slice(0, 1800);
  }
  const start = Math.max(0, idx - 200);
  return plain.slice(start, start + 1800).trim();
}
