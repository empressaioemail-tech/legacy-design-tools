/**
 * Property Brief local code/zoning layer — corpus retrieval with web-first fallback.
 *
 * National baseline (site-context adapters) always fires on geocode; this module
 * resolves the incremental local-code layer per the 2026-06-17 coverage model:
 * warmed Central TX atoms when available, otherwise reuse chat web-first grounding.
 */

import {
  keyFromEngagementOrSynthesize,
  retrieveAtomsForQuestion,
  countAtomsForJurisdiction,
  supplementCodeSectionsWithReasoningGrounding,
  type RetrievedAtom,
} from "@workspace/codes";
import { logger } from "./logger";
import { BROKERAGE_CODE_QUERIES } from "./brokerageCodeQueries";
import { brokerageBriefRetrievalMode } from "./brokerageSpineGate";

export const BRIEF_WEB_SCRAPED_DISCLOSURE =
  "Local code from web search — unverified, web-scraped";

export interface BriefSectionHit {
  atomDid: string;
  snippet: string;
  score: number;
  provenance?: {
    source: "corpus" | "websearch";
    confidence: number;
    verificationState: "verified" | "unverified" | "corpus";
    disclosure?: string;
    sourceUrl?: string;
  };
}

export interface BriefCodeSection {
  title: string;
  query: string;
  hits: BriefSectionHit[];
  coverage?: { degraded: boolean; reason?: string };
}

export interface BriefLocalCodeLayer {
  jurisdictionKey: string | null;
  sections: BriefCodeSection[];
  citations: Array<{ atomDid: string; query: string; snippet: string }>;
  retrievedAtoms: RetrievedAtom[];
  corpusStatus: "in_corpus" | "partial" | "no_match" | "unknown";
  coverage: { degraded: boolean; reason?: string };
  localCodeSource: "corpus" | "websearch" | "none";
}

function sectionTitle(query: string): string {
  const first = query.split(" ")[0] ?? query;
  return first.toUpperCase() + query.slice(first.length, 40);
}

function atomSnippet(atom: RetrievedAtom): string {
  const title = atom.sectionTitle?.trim();
  const body = atom.body?.trim() ?? "";
  if (title && body) return `${title}: ${body}`.slice(0, 500);
  return (body || title || "").slice(0, 500);
}

async function resolveCorpusStatus(
  jurisdictionKey: string | null,
  hasHits: boolean,
): Promise<"in_corpus" | "partial" | "no_match" | "unknown"> {
  if (!jurisdictionKey) return "no_match";
  if (hasHits) return "in_corpus";
  try {
    const count = await countAtomsForJurisdiction(jurisdictionKey);
    return count > 0 ? "partial" : "no_match";
  } catch {
    return "unknown";
  }
}

async function runCorpusRetrieval(
  jurisdictionKey: string,
  retrievalMode: "neon" | "gate" = brokerageBriefRetrievalMode(),
): Promise<{
  sections: BriefCodeSection[];
  citations: Array<{ atomDid: string; query: string; snippet: string }>;
  retrievedAtoms: RetrievedAtom[];
}> {
  const sections: BriefCodeSection[] = [];
  const citations: Array<{ atomDid: string; query: string; snippet: string }> =
    [];
  const retrievedAtoms: RetrievedAtom[] = [];
  const priorMode = process.env.BRIEF_CODE_RETRIEVAL;
  if (retrievalMode === "gate") {
    process.env.BRIEF_CODE_RETRIEVAL = "gate";
  }

  try {
    for (const query of BROKERAGE_CODE_QUERIES) {
      let hits: RetrievedAtom[] = [];
      try {
        hits = await retrieveAtomsForQuestion({
          jurisdictionKey,
          question: query,
          limit: 2,
          logger,
          applyMinScore: false,
        });
      } catch (err) {
        logger.warn({ err, jurisdictionKey, query }, "brokerage: retrieval failed");
      }

      for (const h of hits) retrievedAtoms.push(h);

      if (hits.length > 0) {
        const top = hits[0]!;
        citations.push({
          atomDid: top.id,
          query,
          snippet: atomSnippet(top).slice(0, 280),
        });
      }

      sections.push({
        title: sectionTitle(query),
        query,
        hits: hits.map((h) => ({
          atomDid: h.id,
          snippet: atomSnippet(h),
          score: h.score,
          provenance: {
            source: "corpus" as const,
            confidence: h.score,
            verificationState: "corpus" as const,
          },
        })),
      });
    }
  } finally {
    if (retrievalMode === "gate") {
      if (priorMode === undefined) delete process.env.BRIEF_CODE_RETRIEVAL;
      else process.env.BRIEF_CODE_RETRIEVAL = priorMode;
    }
  }

  return { sections, citations, retrievedAtoms };
}

export async function resolveBriefLocalCodeLayer(input: {
  address: string;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
}): Promise<BriefLocalCodeLayer> {
  const jurisdictionKey = keyFromEngagementOrSynthesize({
    jurisdictionCity: input.jurisdictionCity ?? null,
    jurisdictionState: input.jurisdictionState ?? null,
    address: input.address,
  });

  if (!jurisdictionKey) {
    return {
      jurisdictionKey: null,
      sections: [
        {
          title: "Municipal code",
          query: "jurisdiction",
          hits: [],
          coverage: {
            degraded: true,
            reason: BRIEF_WEB_SCRAPED_DISCLOSURE,
          },
        },
      ],
      citations: [],
      retrievedAtoms: [],
      corpusStatus: "no_match",
      coverage: { degraded: true, reason: BRIEF_WEB_SCRAPED_DISCLOSURE },
      localCodeSource: "none",
    };
  }

  const corpus = await runCorpusRetrieval(jurisdictionKey);
  const hasCorpusHits = corpus.sections.some((s) => s.hits.length > 0);

  if (hasCorpusHits) {
    const corpusStatus = await resolveCorpusStatus(jurisdictionKey, true);
    return {
      jurisdictionKey,
      sections: corpus.sections,
      citations: corpus.citations,
      retrievedAtoms: corpus.retrievedAtoms,
      corpusStatus,
      coverage: { degraded: false },
      localCodeSource: "corpus",
    };
  }

  const existingSections = corpus.sections.flatMap((s) =>
    s.hits.map((h) => ({ atomId: h.atomDid, label: s.title })),
  );

  const grounding = await supplementCodeSectionsWithReasoningGrounding({
    jurisdictionKey,
    existingSections,
    log: (msg, meta) => logger.info({ ...meta, jurisdictionKey }, msg),
  });

  if (grounding.sections.length === 0) {
    const corpusStatus = await resolveCorpusStatus(jurisdictionKey, false);
    return {
      jurisdictionKey,
      sections: corpus.sections,
      citations: corpus.citations,
      retrievedAtoms: corpus.retrievedAtoms,
      corpusStatus,
      coverage: { degraded: true, reason: BRIEF_WEB_SCRAPED_DISCLOSURE },
      localCodeSource: "none",
    };
  }

  const sectionCoverage = {
    degraded: true as const,
    reason: BRIEF_WEB_SCRAPED_DISCLOSURE,
  };

  const webSections: BriefCodeSection[] = grounding.sections.map((w) => ({
    title: w.label,
    query: w.label,
    hits: [
      {
        atomDid: w.atomId,
        snippet: w.snippet ?? "",
        score: w.webProvenance?.confidence ?? 0.35,
        provenance: {
          source: "websearch" as const,
          confidence: w.webProvenance?.confidence ?? 0.35,
          verificationState: w.webProvenance?.verified ? "verified" : "unverified",
          disclosure: BRIEF_WEB_SCRAPED_DISCLOSURE,
          sourceUrl: w.webProvenance?.sourceUrl,
        },
      },
    ],
    coverage: sectionCoverage,
  }));

  const webCitations = grounding.sections.map((w) => ({
    atomDid: w.atomId,
    query: w.label,
    snippet: (w.snippet ?? "").slice(0, 280),
  }));

  const corpusStatus = await resolveCorpusStatus(jurisdictionKey, true);

  return {
    jurisdictionKey,
    sections: [...corpus.sections.filter((s) => s.hits.length > 0), ...webSections],
    citations: [...corpus.citations, ...webCitations],
    retrievedAtoms: corpus.retrievedAtoms,
    corpusStatus,
    coverage: sectionCoverage,
    localCodeSource: "websearch",
  };
}
