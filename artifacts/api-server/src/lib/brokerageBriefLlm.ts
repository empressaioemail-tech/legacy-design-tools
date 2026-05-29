/**
 * Grok + rules fallbacks for Hauska Property Brief brokerage API.
 */

import {
  resolveGrokBriefingModel,
  BRIEFING_GROK_MAX_TOKENS,
} from "@workspace/briefing-engine";
import { getBriefingLlmClient } from "./briefingLlmClient";
import {
  formatBrokerageContextForLlm,
  type BrokerageSiteContext,
} from "./brokerageSiteContext";
import {
  stripInlineCitations,
  type PresentationMode,
} from "./propertyBriefLaySummary";

export const PROPERTY_BRIEF_DISCLAIMER =
  "Property intel from Hauska municipal code catalog. Not legal advice. Verify with city staff and applicable zoning before client representations.";

/** @deprecated Use PROPERTY_BRIEF_DISCLAIMER */
export const BROKERAGE_DISCLAIMER = PROPERTY_BRIEF_DISCLAIMER;

export interface BriefAtomInput {
  atomDid: string;
  snippet: string;
  label?: string;
}

export interface NumberedCitation {
  n: number;
  atomDid: string;
  label: string;
  snippet?: string;
}

export interface ReasoningSummaryResult {
  headline: string;
  paragraphsHtml: string;
  citations: NumberedCitation[];
  disclaimer: string;
  generatedAt: string;
  method: "grok" | "rules-v1";
}

export interface SummarizeResult {
  headline: string;
  html: string;
  summary: string;
  citations: NumberedCitation[];
  disclaimer: string;
  method: "grok" | "rules-v1";
}

export interface ResearchChatResult {
  message: string;
  messageHtml: string;
  /** Pro-mode inline citations (backward compatible). */
  citations: NumberedCitation[];
  /** Consumer contract: technical sources for “See sources” / “For your agent”. */
  sources: NumberedCitation[];
  disclaimer: string;
  confidence: number;
  generatedAt: string;
  method: "grok" | "rules-v1";
  presentationMode: PresentationMode;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jurisdictionLabel(tenant: string | null | undefined): string {
  if (!tenant) return "the applicable jurisdiction";
  return tenant
    .replace(/_/g, " ")
    .replace(/\btx\b/i, "Texas")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function numberedAtomBlock(atoms: BriefAtomInput[]): string {
  return atoms
    .map((a, i) => {
      const label = a.label ?? `Source ${i + 1}`;
      const snip = (a.snippet ?? "").slice(0, 600);
      return `[${i + 1}] atomDid=${a.atomDid}\nlabel: ${label}\n${snip}`;
    })
    .join("\n\n");
}

function parseInlineCitations(
  text: string,
  atoms: BriefAtomInput[],
): NumberedCitation[] {
  const citations: NumberedCitation[] = [];
  const seen = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (seen.has(n) || n < 1 || n > atoms.length) continue;
    seen.add(n);
    const atom = atoms[n - 1]!;
    citations.push({
      n,
      atomDid: atom.atomDid,
      label: atom.label ?? `Source ${n}`,
      snippet: atom.snippet?.slice(0, 280),
    });
  }
  return citations;
}

function textToHtmlParagraphs(text: string): string {
  const parts = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) {
    return `<p>${escapeHtml(text.trim())}</p>`;
  }
  return parts.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

async function completeGrok(system: string, user: string): Promise<string | null> {
  const bundle = await getBriefingLlmClient();
  if (bundle?.kind !== "grok") return null;
  return bundle.client.completeChat({
    model: resolveGrokBriefingModel(),
    maxTokens: BRIEFING_GROK_MAX_TOKENS,
    system,
    user,
  });
}

export function buildRulesReasoningSummary(input: {
  address: string;
  jurisdiction: string | null;
  corpusStatus: string;
  atoms: BriefAtomInput[];
  finishedAt: string;
}): ReasoningSummaryResult {
  const jLabel = jurisdictionLabel(input.jurisdiction);
  const citations: NumberedCitation[] = input.atoms.slice(0, 6).map((a, i) => ({
    n: i + 1,
    atomDid: a.atomDid,
    label: a.label ?? `Topic ${i + 1}`,
    snippet: a.snippet?.slice(0, 280),
  }));

  let headline: string;
  if (input.corpusStatus === "no_match") {
    headline = `We could not match ${input.address} to a corpus-backed city in Hauska yet. Set a default jurisdiction in extension options if this listing is in a covered market (e.g. Bastrop, TX).`;
  } else if (!citations.length) {
    headline = `Hauska searched adopted code for ${jLabel} at ${input.address} but did not surface strong matches on standard buyer-diligence topics. Confirm with city planning before making representations.`;
  } else {
    const topicList = citations.map((c) => c.label).join(", ");
    headline = `For ${input.address}, Hauska reviewed ${jLabel} adopted code and found material provisions on ${topicList}. Below is a reasoning summary for agent diligence—not a compliance determination.`;
  }

  const paragraphs: string[] = [];
  for (const c of citations) {
    paragraphs.push(
      `<p><strong>${escapeHtml(c.label)}.</strong> The adopted code indicates material provisions relevant to buyer diligence. ` +
        `See source [${c.n}]. Agents should confirm whether this applies to the specific zoning district and lot configuration for ${escapeHtml(input.address)}.</p>`,
    );
  }

  return {
    headline,
    paragraphsHtml: paragraphs.join(""),
    citations,
    disclaimer: PROPERTY_BRIEF_DISCLAIMER,
    generatedAt: input.finishedAt,
    method: "rules-v1",
  };
}

export async function generateReasoningSummary(input: {
  address: string;
  jurisdiction: string | null;
  corpusStatus: string;
  atoms: BriefAtomInput[];
  finishedAt: string;
  siteContext?: BrokerageSiteContext;
  privateRestrictionsBlock?: string;
}): Promise<ReasoningSummaryResult> {
  const atoms = input.atoms.slice(0, 12);
  const hasPrivate = Boolean(input.privateRestrictionsBlock?.trim());
  const system = [
    "You are a Texas real estate agent diligence assistant.",
    hasPrivate
      ? "Use numbered code atom sources AND private recorded-restriction excerpts (P1, P2, …) when relevant. Private restrictions are CC&Rs/deed limits — not municipal code."
      : "Write a concise property brief reasoning summary using ONLY the numbered code atom sources provided.",
    "Use inline citations like [1], [2] that map to the source numbers.",
    "Do not guarantee compliance or permit outcomes.",
    "Respond with JSON only: {\"headline\": string, \"body\": string (plain text, multiple paragraphs separated by blank lines)}.",
  ].join(" ");

  const siteBlock = formatBrokerageContextForLlm({
    siteContext: input.siteContext,
    privateRestrictionsBlock: input.privateRestrictionsBlock,
  });

  const user = [
    `Address: ${input.address}`,
    `Jurisdiction: ${input.jurisdiction ?? "unknown"}`,
    `Corpus status: ${input.corpusStatus}`,
    siteBlock ? `\n${siteBlock}` : "",
    "",
    "Sources:",
    numberedAtomBlock(atoms),
  ].join("\n");

  const raw = await completeGrok(system, user);
  if (!raw) {
    return buildRulesReasoningSummary(input);
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw) as {
      headline?: string;
      body?: string;
    };
    const body = (parsed.body ?? "").trim();
    const citations = parseInlineCitations(body, atoms);
    return {
      headline:
        parsed.headline?.trim() ||
        `Property brief for ${input.address} (${jurisdictionLabel(input.jurisdiction)}).`,
      paragraphsHtml: textToHtmlParagraphs(body),
      citations,
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      generatedAt: input.finishedAt,
      method: "grok",
    };
  } catch {
    const citations = parseInlineCitations(raw, atoms);
    return {
      headline: `Property brief for ${input.address}.`,
      paragraphsHtml: textToHtmlParagraphs(raw),
      citations,
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      generatedAt: input.finishedAt,
      method: "grok",
    };
  }
}

export async function generateSummarize(input: {
  address: string;
  jurisdiction: string | null;
  corpusStatus: string;
  atoms: BriefAtomInput[];
}): Promise<SummarizeResult> {
  const atoms = input.atoms.slice(0, 12);
  const system = [
    "You are a Texas real estate agent diligence assistant.",
    "Summarize the provided municipal code atom snippets for a listing brief.",
    "Require inline [n] citations matching the source numbers. No compliance guarantees.",
    "Respond with JSON only: {\"headline\": string, \"body\": string (plain text)}.",
  ].join(" ");

  const user = [
    `Address: ${input.address}`,
    `Jurisdiction: ${input.jurisdiction ?? "unknown"}`,
    `Corpus: ${input.corpusStatus}`,
    "",
    numberedAtomBlock(atoms),
  ].join("\n");

  const raw = await completeGrok(system, user);
  if (!raw) {
    const rules = buildRulesReasoningSummary({
      ...input,
      finishedAt: new Date().toISOString(),
    });
    return {
      headline: rules.headline,
      html: rules.paragraphsHtml,
      summary: rules.headline,
      citations: rules.citations,
      disclaimer: rules.disclaimer,
      method: "rules-v1",
    };
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw) as {
      headline?: string;
      body?: string;
    };
    const body = (parsed.body ?? "").trim();
    return {
      headline: parsed.headline?.trim() || `Summary for ${input.address}`,
      html: textToHtmlParagraphs(body),
      summary: body.split(/\n\n+/)[0]?.trim() || parsed.headline?.trim() || "",
      citations: parseInlineCitations(body, atoms),
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      method: "grok",
    };
  } catch {
    return {
      headline: `Summary for ${input.address}`,
      html: textToHtmlParagraphs(raw),
      summary: raw.slice(0, 280),
      citations: parseInlineCitations(raw, atoms),
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      method: "grok",
    };
  }
}

function finalizeResearchChatAnswer(
  answer: string,
  atoms: BriefAtomInput[],
  presentationMode: PresentationMode,
  generatedAt: string,
  method: "grok" | "rules-v1",
): ResearchChatResult {
  const citations = parseInlineCitations(answer, atoms);
  const consumer = presentationMode === "consumer";
  const plain = consumer ? stripInlineCitations(answer) : answer;
  return {
    message: plain,
    messageHtml: textToHtmlParagraphs(plain),
    citations,
    sources: citations,
    disclaimer: PROPERTY_BRIEF_DISCLAIMER,
    confidence: citations.length > 0 ? 0.75 : 0.5,
    generatedAt,
    method,
    presentationMode,
  };
}

export async function generateResearchChat(input: {
  address: string;
  jurisdiction: string | null;
  message: string;
  history: Array<{ role: string; content: string }>;
  atoms: BriefAtomInput[];
  siteContext?: BrokerageSiteContext;
  privateRestrictionsBlock?: string;
  presentationMode?: PresentationMode;
}): Promise<ResearchChatResult> {
  const presentationMode = input.presentationMode ?? "consumer";
  const atoms = input.atoms.slice(0, 16);
  const hasPrivate = Boolean(input.privateRestrictionsBlock?.trim());
  const historyBlock = input.history
    .slice(-8)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");

  const system = [
    "You are a Texas property intel assistant (lay-friendly Carfax-for-property).",
    presentationMode === "consumer"
      ? "Answer in plain English for a homebuyer. Do NOT include [n] citation markers or statute numbers in the answer text."
      : "Answer for a real estate professional. Cite with [n] inline matching source numbers.",
    hasPrivate
      ? "Use numbered code sources and private recorded-restriction excerpts (P1, P2, …) when the question touches HOA/CC&R/deed limits. Private restrictions are not municipal code."
      : "Use ONLY the numbered code atom sources. Do not invent code.",
    "No compliance guarantees.",
    "Respond with JSON only: {\"answer\": string (plain text)}.",
  ].join(" ");

  const siteBlock = formatBrokerageContextForLlm({
    siteContext: input.siteContext,
    privateRestrictionsBlock: input.privateRestrictionsBlock,
  });

  const user = [
    `Property: ${input.address}`,
    `Jurisdiction: ${input.jurisdiction ?? "unknown"}`,
    siteBlock ? `\n${siteBlock}` : "",
    "",
    "Conversation:",
    historyBlock || "(none)",
    "",
    `User question: ${input.message}`,
    "",
    "Sources:",
    numberedAtomBlock(atoms),
  ].join("\n");

  const raw = await completeGrok(system, user);
  const generatedAt = new Date().toISOString();

  if (!raw) {
    const msg =
      atoms.length > 0
        ? `Based on the available code sources for ${input.address}, please review the cited provisions with city staff. I do not have enough grounded context to answer "${input.message}" in mock mode.`
        : `No code atoms are available for this jurisdiction. Confirm corpus coverage for ${input.jurisdiction ?? "this market"} before answering "${input.message}".`;
    return {
      message: msg,
      messageHtml: `<p>${escapeHtml(msg)}</p>`,
      citations: [],
      sources: [],
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      confidence: atoms.length > 0 ? 0.4 : 0.1,
      generatedAt,
      method: "rules-v1",
      presentationMode,
    };
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw) as { answer?: string };
    const answer = (parsed.answer ?? raw).trim();
    return finalizeResearchChatAnswer(
      answer,
      atoms,
      presentationMode,
      generatedAt,
      "grok",
    );
  } catch {
    return finalizeResearchChatAnswer(
      raw.trim(),
      atoms,
      presentationMode,
      generatedAt,
      "grok",
    );
  }
}
