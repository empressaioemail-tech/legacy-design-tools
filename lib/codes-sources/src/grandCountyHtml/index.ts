/**
 * Grand County, UT — Design Criteria HTML scraper.
 *
 * Source page: https://www.grandcountyutah.net/146/Design-Criteria
 *
 * The page hosts the Building Department's design-criteria reference.
 * Of structural value is an inline collapsible block titled "2021 IRC TABLE
 * 301.2(1) — CLIMACTIC AND GEOGRAPHIC DESIGN CRITERIA" containing the
 * jurisdiction's filled-in values for IRC R301.2(1). We extract the table
 * and emit one atom for the table itself plus one atom per footnote (a-m).
 */

import { load } from "cheerio";
import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";

const PAGE_URL = "https://www.grandcountyutah.net/146/Design-Criteria";
const USER_AGENT =
  process.env.HAUSKA_USER_AGENT ?? "Hauska-CodeAtoms/0.1 (+nick@hauska.io)";

async function fetchPageHtml(): Promise<string> {
  const res = await fetch(PAGE_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `grandCountyHtml: GET ${PAGE_URL} -> HTTP ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

function squish(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export const grandCountyHtmlSource: CodeSource = {
  id: "grand_county_html",
  label: "Grand County, UT — Design Criteria (HTML)",
  sourceType: "html",
  licenseType: "public_record",

  async listToc(_input): Promise<TocEntry[]> {
    // The HTML page is single-document. We expose one TOC entry; fetchSection
    // will scrape the table and footnotes into multiple AtomCandidates.
    return [
      {
        sectionUrl: PAGE_URL,
        sectionRef: "R301.2(1)",
        sectionTitle:
          "2021 IRC Table 301.2(1) — Climatic and Geographic Design Criteria",
        parentSection: "R301.2",
        context: { kind: "design_criteria_table" },
      },
    ];
  },

  async fetchSection(
    sectionUrl: string,
    _ctx: FetchContext,
  ): Promise<AtomCandidate[]> {
    const html = await fetchPageHtml();
    const $ = load(html);
    const candidates: AtomCandidate[] = [];

    // Find the collapsible button whose text contains "TABLE 301.2(1)" and
    // walk to its sibling .content div which contains the actual <table>.
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
      sourceUrl: sectionUrl,
      metadata: {
        kind: "design_criteria_table",
        codeBookEdition: "IRC 2021",
        scrapedAt: new Date().toISOString(),
      },
    });

    // Each <tr> with `colspan="2"` cells starting "a.", "b.", … is a footnote.
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
        sourceUrl: sectionUrl,
        metadata: {
          kind: "design_criteria_table_footnote",
          footnote: letter,
          scrapedAt: new Date().toISOString(),
        },
      });
    });

    return candidates;
  },
};
