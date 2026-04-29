/**
 * Municode source adapter — direct Node implementation against api.municode.com.
 *
 * Resolution chain (verified during Sprint A05 reconnaissance):
 *   /Clients/name?clientName=…&stateAbbr=…   → ClientID
 *   /ClientContent/{clientId}                → codes[0].productId
 *   /Jobs/latest/{productId}                 → Id (=jobId), Name (=edition)
 *   /codesToc/children?jobId=…&productId=…   → top-level chapter listing
 *   /codesToc/children?…&nodeId=…            → children of any TOC node
 *   /CodesContent?…&nodeId=…                 → Docs[] with Content (HTML)
 *
 * For a sprint-A05 demo warmup we walk depth ≤ 2 (chapter → article) and
 * fetch CodesContent at the article level. That returns one envelope whose
 * Docs[] contain every section in the article. We promote each Doc with a
 * non-null Content into one AtomCandidate.
 */

import type { CodeSource, TocEntry, AtomCandidate, FetchContext } from "../types";
import { libraryUrl } from "./endpoints";
import {
  getClientByName,
  getClientContent,
  getLatestJob,
  getTocChildren,
  getCodesContent,
  type MunicodeJob,
  type MunicodeCodeProduct,
} from "./client";
import { parseSectionResponse } from "./parser";

export { municodeStats, MunicodeError, MunicodeDailyCapExceeded } from "./client";
export { parseSectionResponse, htmlToPlainText } from "./parser";

interface MunicodeAdapterConfig {
  /** Optional pre-resolved Municode ClientID. If omitted, we resolve via /Clients/name. */
  municodeClientId?: number;
  /** Required: human-friendly municipality name to look up if clientId not provided. */
  municipalityName?: string;
  /** Required: 2-letter state code (e.g. "TX"). */
  stateAbbr?: string;
  /**
   * Soft cap on enqueued TOC nodes per warmup pass. Demand-driven warmup
   * doesn't need the entire code; we surface enough breadth for retrieval to
   * find something on a typical question. Default 30.
   */
  maxTocNodes?: number;
  /**
   * URL slug used to build canonical library.municode.com verification URLs
   * (e.g. "bastrop"). If omitted, the lower-cased municipality name is used.
   */
  librarySlug?: string;
}

interface MunicodeContext {
  jobId: number;
  productId: number;
  clientId: number;
  stateAbbr: string;
  librarySlug: string;
}

async function resolveContext(
  cfg: MunicodeAdapterConfig,
): Promise<{ ctx: MunicodeContext; job: MunicodeJob; product: MunicodeCodeProduct }> {
  if (!cfg.stateAbbr) {
    throw new Error(
      "municodeSource: jurisdictions config must supply { stateAbbr }",
    );
  }
  let clientId = cfg.municodeClientId;
  if (!clientId) {
    if (!cfg.municipalityName) {
      throw new Error(
        "municodeSource: jurisdictions config needs municipalityName or municodeClientId",
      );
    }
    const info = await getClientByName(cfg.municipalityName, cfg.stateAbbr);
    if (!info) {
      throw new Error(
        `municodeSource: no Municode client found for ${cfg.municipalityName}, ${cfg.stateAbbr}`,
      );
    }
    clientId = info.ClientID;
  }
  const content = await getClientContent(clientId);
  const product = content.codes?.[0];
  if (!product) {
    throw new Error(
      `municodeSource: client ${clientId} has no codes[] product`,
    );
  }
  const job = await getLatestJob(product.productId);
  if (!job) {
    throw new Error(
      `municodeSource: no latest job for productId ${product.productId}`,
    );
  }
  return {
    ctx: {
      jobId: job.Id,
      productId: product.productId,
      clientId,
      stateAbbr: cfg.stateAbbr,
      librarySlug:
        cfg.librarySlug ??
        (cfg.municipalityName?.toLowerCase().replace(/\s+/g, "_") ?? "index"),
    },
    job,
    product,
  };
}

export const municodeSource: CodeSource = {
  id: "bastrop_municode",
  label: "Municode (Bastrop, TX)",
  sourceType: "api",
  licenseType: "permitted_use",

  async listToc(input): Promise<TocEntry[]> {
    const cfg = (input.config ?? {}) as MunicodeAdapterConfig;
    const maxNodes = cfg.maxTocNodes ?? 30;
    const { ctx } = await resolveContext(cfg);

    const entries: TocEntry[] = [];
    // Depth 1: top-level chapters.
    const top = await getTocChildren(ctx.jobId, ctx.productId);
    for (const chapter of top) {
      if (entries.length >= maxNodes) break;
      // Skip cover, history, charter compare table, etc.
      if (!chapter.HasChildren) {
        entries.push({
          sectionUrl: libraryUrl(ctx.stateAbbr, ctx.librarySlug, chapter.Id),
          sectionRef: chapter.Heading,
          sectionTitle: chapter.Heading,
          parentSection: null,
          context: {
            kind: "municode_node",
            nodeId: chapter.Id,
            jobId: ctx.jobId,
            productId: ctx.productId,
            stateAbbr: ctx.stateAbbr,
            librarySlug: ctx.librarySlug,
          },
        });
        continue;
      }
      // Depth 2: articles inside each chapter.
      const articles = await getTocChildren(ctx.jobId, ctx.productId, chapter.Id);
      for (const article of articles) {
        if (entries.length >= maxNodes) break;
        entries.push({
          sectionUrl: libraryUrl(ctx.stateAbbr, ctx.librarySlug, article.Id),
          sectionRef: article.Heading,
          sectionTitle: `${chapter.Heading} → ${article.Heading}`,
          parentSection: chapter.Heading,
          context: {
            kind: "municode_node",
            nodeId: article.Id,
            jobId: ctx.jobId,
            productId: ctx.productId,
            stateAbbr: ctx.stateAbbr,
            librarySlug: ctx.librarySlug,
            chapterId: chapter.Id,
            chapterHeading: chapter.Heading,
          },
        });
      }
    }
    return entries;
  },

  async fetchSection(
    sectionUrl: string,
    fetchCtx: FetchContext,
  ): Promise<AtomCandidate[]> {
    const c = (fetchCtx.context ?? {}) as Record<string, unknown>;
    const nodeId = String(c.nodeId ?? "");
    const jobId = Number(c.jobId);
    const productId = Number(c.productId);
    const stateAbbr = String(c.stateAbbr ?? "");
    const librarySlug = String(c.librarySlug ?? "");
    if (!nodeId || !jobId || !productId) {
      throw new Error(
        `municodeSource: fetchSection needs context.nodeId/jobId/productId; got ${JSON.stringify(c)}`,
      );
    }

    const env = await getCodesContent(jobId, productId, nodeId);
    return parseSectionResponse(env, {
      parentNodeId: nodeId,
      jobId,
      productId,
      stateAbbr,
      librarySlug,
      chapterHeading: c.chapterHeading ? String(c.chapterHeading) : undefined,
      fallbackUrl: sectionUrl,
    });
  },
};
