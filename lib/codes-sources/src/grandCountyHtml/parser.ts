/**
 * Pure parser for the Grand County design-criteria HTML page.
 *
 * Extracted from index.ts so tests can drive it from a captured fixture
 * without making a live HTTP request.
 */

import { load } from "cheerio";
import type { AtomCandidate } from "../types";

function squish(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Parse the rendered HTML of https://www.grandcountyutah.net/146/Design-Criteria
 * into one atom for the IRC R301.2(1) table plus one atom per footnote (a-m).
 *
 * Throws if the expected collapsible block is not present — fail loud rather
 * than silently emit an empty list, since this page structure is the contract.
 */
export function parseDesignCriteriaHtml(
  html: string,
  sourceUrl: string,
  scrapedAt: string = new Date().toISOString(),
): AtomCandidate[] {
  const $ = load(html);
  const candidates: AtomCandidate[] = [];

  const button = $(".collapsible")
    .filter((_i, el) => /301\.2\(1\)/.test($(el).text()))
    .first();
  if (button.length === 0) {
    throw new Error(
      "grandCountyHtml: could not locate '2021 IRC Table 301.2(1)' collapsible on page",
    );
  }
  const target = button.next(".content");
  if (target.length === 0) {
    throw new Error(
      "grandCountyHtml: collapsible found but sibling .content is missing",
    );
  }

  const tableHtml = target.find("table").first().html() ?? "";
  const tableText = squish(target.find("table").first().text());

  candidates.push({
    sectionRef: "R301.2(1)",
    sectionTitle:
      "2021 IRC Table 301.2(1) — Climatic and Geographic Design Criteria (Grand County, UT values)",
    parentSection: "R301.2",
    body: tableText,
    bodyHtml: `<table>${tableHtml}</table>`,
    sourceUrl,
    metadata: {
      kind: "design_criteria_table",
      codeBookEdition: "IRC 2021",
      scrapedAt,
    },
  });

  target.find("tr td[colspan='2']").each((_i: number, el) => {
    const text = squish($(el).text());
    const m = /^([a-z])\.\s+/.exec(text);
    if (!m) return;
    const letter = m[1];
    candidates.push({
      sectionRef: `R301.2(1) note ${letter}`,
      sectionTitle: `2021 IRC Table 301.2(1) footnote ${letter}`,
      parentSection: "R301.2(1)",
      body: text,
      bodyHtml: $.html(el),
      sourceUrl,
      metadata: {
        kind: "design_criteria_table_footnote",
        footnote: letter,
        scrapedAt,
      },
    });
  });

  return candidates;
}
