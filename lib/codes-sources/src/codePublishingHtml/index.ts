/**
 * Grand County, UT — Land Use Code (HTML on codepublishing.com).
 *
 * Static TOC: the 10 article URLs are baked in below. Hydration GETs each
 * article and delegates to {@link parseCodePublishingArticle}. Politeness
 * is enforced by a process-wide serial queue with a min gap + jitter and
 * a custom User-Agent.
 *
 * See `GRAND_COUNTY_LANDUSE_RECON.md` for the full source survey.
 */

import PQueue from "p-queue";
import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";
import { parseCodePublishingArticle } from "./parser";

export {
  parseCodePublishingArticle,
  MAX_CHARS_PER_CHUNK,
  type ParseArticleOptions,
  type ParsedArticle,
} from "./parser";

const BASE_URL = "https://www.codepublishing.com/UT/GrandCounty";
const ARTICLE_BASE = `${BASE_URL}/html/GrandCountyLUC`;
const USER_AGENT =
  process.env.HAUSKA_USER_AGENT ?? "Hauska-CodeAtoms/0.1 (+nick@hauska.io)";

const MIN_GAP_MS = Number(process.env.CODEPUBLISHING_MIN_GAP_MS ?? "1000");
const JITTER_MAX_MS = Number(process.env.CODEPUBLISHING_JITTER_MAX_MS ?? "500");

const fetchQueue = new PQueue({ concurrency: 1 });
let lastRequestTs = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetchHtml(url: string): Promise<string> {
  return await (fetchQueue.add(async () => {
    const jitter = JITTER_MAX_MS > 0 ? Math.floor(Math.random() * JITTER_MAX_MS) : 0;
    const wait = Math.max(0, lastRequestTs + MIN_GAP_MS + jitter - Date.now());
    if (wait > 0) await delay(wait);
    lastRequestTs = Date.now();

    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        `codePublishingHtml: GET ${url} -> HTTP ${res.status} ${res.statusText}`,
      );
    }
    return await res.text();
  }) as Promise<string>);
}

/**
 * The 10 substantive article HTML pages that make up the Grand County Land
 * Use Code. The two appendix pages (LUCAddA, LUCAddB) on the platform's
 * left-rail TOC are forwarding-link stubs and are intentionally NOT
 * fetched, so the warmup makes exactly 10 GETs.
 */
const ARTICLES: ReadonlyArray<{ id: string; ref: string; title: string }> = [
  { id: "LUC01", ref: "1", title: "General Provisions" },
  { id: "LUC02", ref: "2", title: "Zoning Districts" },
  { id: "LUC03", ref: "3", title: "Use Regulations" },
  { id: "LUC04", ref: "4", title: "Special Purpose and Overlay Districts" },
  { id: "LUC05", ref: "5", title: "Lot Design Standards" },
  { id: "LUC06", ref: "6", title: "General Development Standards" },
  { id: "LUC07", ref: "7", title: "Subdivision Standards" },
  { id: "LUC08", ref: "8", title: "Decision-making Bodies" },
  { id: "LUC09", ref: "9", title: "Administration and Procedures" },
  { id: "LUC10", ref: "10", title: "Definitions" },
];

function articleUrl(id: string): string {
  return `${ARTICLE_BASE}/GrandCounty${id}.html`;
}

export const grandCountyLanduseHtmlSource: CodeSource = {
  id: "grand_county_landuse_html",
  label: "Grand County, UT — Land Use Code (HTML, codepublishing.com)",
  sourceType: "html",
  licenseType: "public_record",

  async listToc(_input): Promise<TocEntry[]> {
    return ARTICLES.map((a) => ({
      sectionUrl: articleUrl(a.id),
      sectionRef: `Article ${a.ref}`,
      sectionTitle: a.title,
      parentSection: null,
      context: { kind: "code_publishing_article", articleId: a.id },
    }));
  },

  async fetchSection(
    sectionUrl: string,
    _ctx: FetchContext,
  ): Promise<AtomCandidate[]> {
    const html = await politeFetchHtml(sectionUrl);
    return parseCodePublishingArticle(html, { sourceUrl: sectionUrl });
  },
};

/**
 * TEST-ONLY: reset the politeness module-level state so tests can run
 * multiple scenarios from a clean baseline. Production code must never call
 * this.
 */
export function __resetCodePublishingClientStateForTesting(): void {
  lastRequestTs = 0;
  fetchQueue.clear();
}
