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
 *
 * The pure parsing logic lives in `./parser.ts` for unit testing; this file
 * is thin glue that performs the HTTP fetch and delegates.
 */

import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";
import { parseDesignCriteriaHtml } from "./parser";

export { parseDesignCriteriaHtml } from "./parser";

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

export const grandCountyHtmlSource: CodeSource = {
  id: "grand_county_html",
  label: "Grand County, UT — Design Criteria (HTML)",
  sourceType: "html",
  licenseType: "public_record",

  async listToc(_input): Promise<TocEntry[]> {
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
    return parseDesignCriteriaHtml(html, sectionUrl);
  },
};
