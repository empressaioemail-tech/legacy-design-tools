/**
 * Labeled web-search backup for PE research chat (WDLL P-60 item 4).
 *
 * Reuses the brief's web-first grounding
 * (`supplementCodeSectionsWithReasoningGrounding`) and the same allowlisted
 * fetch (`fetchAllowlistedUrl` / `websearchAtomId`). Does not invent a
 * second scraper. Does not add ICC review targets. Civic pages (official
 * ISD, TEA, city, county) are fetched only on a corpus miss for school
 * assignment or ADU / additional-unit / subdivision questions.
 *
 * Corpus hits stay corpus. Web text is asserted, labeled, timestamped.
 * A fetch that cannot run is a labeled degrade, never a silent skip.
 */

import {
  fetchAllowlistedUrl,
  isAllowlistedWebHost,
  supplementCodeSectionsWithReasoningGrounding,
  websearchAtomId,
  type HttpFetcher,
  type WebCodeSectionInput,
} from "@workspace/codes";
import { BRIEF_WEB_SCRAPED_DISCLOSURE } from "./brokerageBriefLocalCode";
import type { BriefAtomInput } from "./brokerageBriefLlm";
import { logger } from "./logger";

export const RESEARCH_CHAT_WEBSEARCH_DISCLOSURE =
  "Web-search backup — not a Hauska atom. Official civic page, unverified.";

export const RESEARCH_CHAT_WEBSEARCH_ASSERTED_CONFIDENCE = 0.35;

export const RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED =
  "Web-search backup could not run against the civic allowlist; answer is degraded, not silently skipped.";

const SCHOOL_TOPIC_RE =
  /\b(school|schools|isd|bisd|attendance zone|school assignment|school district)\b/i;

const ADU_SUBDIVISION_TOPIC_RE =
  /\b(adu|accessory dwelling|additional unit|secondary unit|subdivision|guest house|granny flat|backyard cottage)\b/i;

export type CivicChatTopic = "schools" | "adu_subdivision";

type CivicTarget = {
  topic: CivicChatTopic;
  url: string;
  label: string;
  codeRef: string;
};

const TEA_SCHOOL_LOCATOR: CivicTarget = {
  topic: "schools",
  url: "https://tea.texas.gov/texas-schools/general-information/school-district-locator",
  label: "TEA school district locator",
  codeRef: "tea-school-locator",
};

const CIVIC_TARGETS_BY_JURISDICTION: Record<string, CivicTarget[]> = {
  bastrop_tx: [
    TEA_SCHOOL_LOCATOR,
    {
      topic: "schools",
      url: "https://www.bastropisd.org/",
      label: "Bastrop ISD",
      codeRef: "bastrop-isd",
    },
    {
      topic: "adu_subdivision",
      url: "https://www.cityofbastrop.org/",
      label: "City of Bastrop",
      codeRef: "bastrop-city-adu",
    },
  ],
  georgetown_tx: [
    TEA_SCHOOL_LOCATOR,
    {
      topic: "schools",
      url: "https://www.georgetownisd.org/",
      label: "Georgetown ISD",
      codeRef: "georgetown-isd",
    },
    {
      topic: "adu_subdivision",
      url: "https://www.georgetown.org/",
      label: "City of Georgetown",
      codeRef: "georgetown-city-adu",
    },
  ],
};

let injectedHttp: HttpFetcher | null | undefined;

export function setResearchChatCivicHttpForTests(http: HttpFetcher | null): void {
  injectedHttp = http;
}

export function resetResearchChatCivicHttpForTests(): void {
  injectedHttp = undefined;
}

function resolveHttp(): HttpFetcher | undefined {
  if (injectedHttp === undefined) return undefined;
  if (injectedHttp === null) {
    return async () => {
      throw new Error("research chat civic fetch is disabled in this test");
    };
  }
  return injectedHttp;
}

export function detectCivicChatTopics(message: string): CivicChatTopic[] {
  const topics: CivicChatTopic[] = [];
  if (SCHOOL_TOPIC_RE.test(message)) topics.push("schools");
  if (ADU_SUBDIVISION_TOPIC_RE.test(message)) topics.push("adu_subdivision");
  return topics;
}

export function corpusCoversCivicTopic(
  atoms: ReadonlyArray<Pick<BriefAtomInput, "atomDid" | "label" | "snippet">>,
  topic: CivicChatTopic,
): boolean {
  const re = topic === "schools" ? SCHOOL_TOPIC_RE : ADU_SUBDIVISION_TOPIC_RE;
  return atoms.some((a) => {
    if (a.atomDid.startsWith("websearch:") || a.atomDid.startsWith("reasoning:")) {
      return false;
    }
    return re.test(`${a.label ?? ""} ${a.snippet ?? ""}`);
  });
}

export function assertLabeledWebSearchCitation(citation: {
  atomDid: string;
  label?: string;
  snippet?: string;
  disclosure?: string;
  source?: string;
}): void {
  const labeled =
    citation.atomDid.startsWith("websearch:") &&
    (citation.disclosure?.toLowerCase().includes("web-search") ||
      citation.label?.toLowerCase().includes("web-search backup") ||
      citation.snippet?.toLowerCase().includes("web-search backup"));
  if (!labeled) {
    throw new Error(
      "unlabeled web text: civic backup must cite websearch: with a web-search disclosure",
    );
  }
  if (citation.source === "corpus") {
    throw new Error(
      "unlabeled web text: web-search backup must not present as earned corpus",
    );
  }
}

function civicTargetsFor(
  jurisdictionKey: string,
  topics: CivicChatTopic[],
): CivicTarget[] {
  const rows = CIVIC_TARGETS_BY_JURISDICTION[jurisdictionKey] ?? [];
  const fromTable = rows.filter((t) => topics.includes(t.topic));
  if (topics.includes("schools") && !fromTable.some((t) => t.topic === "schools")) {
    return [...fromTable, TEA_SCHOOL_LOCATOR];
  }
  return fromTable;
}

function excerptHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function webSectionToBriefAtom(section: WebCodeSectionInput): BriefAtomInput {
  const retrievedAt = section.webProvenance.retrievedAt;
  return {
    atomDid: section.atomId,
    snippet: `${RESEARCH_CHAT_WEBSEARCH_DISCLOSURE} ${section.snippet ?? ""}`.slice(
      0,
      600,
    ),
    label: `${section.label} — web-search backup, not a Hauska atom`,
    sourceUrl: section.webProvenance.sourceUrl,
    webSearchBackup: {
      disclosure: RESEARCH_CHAT_WEBSEARCH_DISCLOSURE,
      confidence: section.webProvenance.confidence,
      retrievedAt,
      verificationState: "unverified",
    },
  };
}

function civicHitToBriefAtom(input: {
  target: CivicTarget;
  text: string;
  sourceUrl: string;
  retrievedAt: string;
}): BriefAtomInput {
  const atomDid = websearchAtomId("civic", input.target.codeRef);
  const snippet =
    `${RESEARCH_CHAT_WEBSEARCH_DISCLOSURE} ${input.text}`.slice(0, 600);
  return {
    atomDid,
    snippet,
    label: `${input.target.label} — web-search backup, not a Hauska atom`,
    sourceUrl: input.sourceUrl,
    webSearchBackup: {
      disclosure: RESEARCH_CHAT_WEBSEARCH_DISCLOSURE,
      confidence: RESEARCH_CHAT_WEBSEARCH_ASSERTED_CONFIDENCE,
      retrievedAt: input.retrievedAt,
      verificationState: "unverified",
    },
  };
}

export async function resolveResearchChatWebSearchBackup(input: {
  jurisdictionKey: string | null;
  message: string;
  existingAtoms: ReadonlyArray<BriefAtomInput>;
}): Promise<{
  atoms: BriefAtomInput[];
  localCodeSource: "websearch" | "none";
  degradedReasons: string[];
}> {
  const topics = detectCivicChatTopics(input.message);
  const needed = topics.filter(
    (t) => !corpusCoversCivicTopic(input.existingAtoms, t),
  );

  if (needed.length === 0) {
    return { atoms: [], localCodeSource: "none", degradedReasons: [] };
  }

  if (!input.jurisdictionKey) {
    return {
      atoms: [],
      localCodeSource: "none",
      degradedReasons: [RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED],
    };
  }

  const atoms: BriefAtomInput[] = [];
  const degradedReasons: string[] = [];
  let fetchAttempted = false;
  let fetchSucceeded = false;

  const existingSections = input.existingAtoms
    .filter((a) => a.atomDid && !a.atomDid.startsWith("websearch:"))
    .map((a) => ({ atomId: a.atomDid, label: a.label ?? a.atomDid }));

  const http = resolveHttp();

  try {
    fetchAttempted = true;
    const grounding = await supplementCodeSectionsWithReasoningGrounding({
      jurisdictionKey: input.jurisdictionKey,
      existingSections,
      ...(http ? { http } : {}),
      log: (msg, meta) =>
        logger.info({ ...meta, jurisdictionKey: input.jurisdictionKey }, msg),
    });
    for (const section of grounding.sections) {
      if (
        !section.atomId.startsWith("websearch:") &&
        !section.atomId.startsWith("reasoning:")
      ) {
        continue;
      }
      const atom = webSectionToBriefAtom(section);
      assertLabeledWebSearchCitation({
        atomDid: atom.atomDid,
        label: atom.label,
        snippet: atom.snippet,
        disclosure: atom.webSearchBackup?.disclosure,
      });
      atoms.push(atom);
      fetchSucceeded = true;
    }
  } catch (err) {
    logger.warn(
      { err, jurisdictionKey: input.jurisdictionKey },
      "brokerage: research chat web-first grounding failed",
    );
  }

  for (const target of civicTargetsFor(input.jurisdictionKey, needed)) {
    let host: string;
    try {
      host = new URL(target.url).hostname;
    } catch {
      degradedReasons.push(RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED);
      continue;
    }
    if (!isAllowlistedWebHost(host)) {
      degradedReasons.push(RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED);
      continue;
    }
    fetchAttempted = true;
    try {
      const res = await fetchAllowlistedUrl(target.url, http);
      if (res.status < 200 || res.status >= 400) {
        continue;
      }
      const text = excerptHtml(res.body);
      if (!text) continue;
      const atom = civicHitToBriefAtom({
        target,
        text,
        sourceUrl: res.finalUrl || target.url,
        retrievedAt: new Date().toISOString(),
      });
      assertLabeledWebSearchCitation({
        atomDid: atom.atomDid,
        label: atom.label,
        snippet: atom.snippet,
        disclosure: atom.webSearchBackup?.disclosure,
      });
      atoms.push(atom);
      fetchSucceeded = true;
    } catch (err) {
      logger.warn(
        { err, url: target.url, jurisdictionKey: input.jurisdictionKey },
        "brokerage: research chat civic web-search failed",
      );
    }
  }

  if (fetchAttempted && !fetchSucceeded && atoms.length === 0) {
    if (!degradedReasons.includes(RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED)) {
      degradedReasons.push(RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED);
    }
  }

  return {
    atoms,
    localCodeSource: atoms.length > 0 ? "websearch" : "none",
    degradedReasons,
  };
}
