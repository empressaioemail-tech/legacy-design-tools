/**
 * Grok + rules fallbacks for Hauska Property Brief brokerage API.
 */

import {
  resolveGrokBriefingModel,
  BRIEFING_GROK_MAX_TOKENS,
  BRIEFING_ANTHROPIC_MODEL,
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
  sourceUrl?: string;
  /**
   * Non-atom-chain entity identifier for sources that aren't (yet) backed by
   * a Hauska property atom DID — e.g. the subject-parcel constraints entry,
   * keyed by parcelNodeId until the hauska-engine atom-chain wire enrichment
   * (feat/atom-chain-wire-dids) ships a real DID. Optional and additive.
   */
  entityId?: string;
  /**
   * Hauska property atom DID for this source entry, once the atom chain
   * carries one. Undefined/omitted today for entity-sourced (non-code-atom)
   * entries — populate later without a wire break.
   */
  did?: string;
  /**
   * Retrieval strength for this atom, when the caller has one (e.g.
   * RetrievedAtom.score from lib/codes retrieval — vector path: 1 -
   * cosine_distance, roughly 0-1; lexical path: integer bag-of-words match
   * count, NOT on the same scale). Omitted for entries with no retrieval
   * score (subject-parcel-facts, prior-brief citations). Additive; feeds the
   * grounding-derived confidence estimate (see computeGroundingConfidence).
   */
  score?: number;
  /** "vector" | "lexical", mirrors RetrievedAtom.retrievalMode when known. */
  retrievalMode?: string;
  /**
   * Labeled web-search backup (PE chat civic miss). Asserted, never earned
   * corpus. Presence means atomDid must be `websearch:` / `reasoning:`.
   */
  webSearchBackup?: {
    disclosure: string;
    confidence: number;
    retrievedAt: string;
    verificationState: "unverified";
  };
}

export interface NumberedCitation {
  n: number;
  atomDid: string;
  label: string;
  snippet?: string;
  sourceUrl?: string;
  /** See BriefAtomInput.entityId. */
  entityId?: string;
  /** See BriefAtomInput.did. */
  did?: string;
  disclosure?: string;
  source?: "corpus" | "websearch";
  confidence?: number;
  retrievedAt?: string;
}

export interface ReasoningSummaryResult {
  headline: string;
  paragraphsHtml: string;
  citations: NumberedCitation[];
  disclaimer: string;
  generatedAt: string;
  method: "grok" | "anthropic" | "rules-v1";
}

export interface SummarizeResult {
  headline: string;
  html: string;
  summary: string;
  citations: NumberedCitation[];
  disclaimer: string;
  method: "grok" | "anthropic" | "rules-v1";
}

/**
 * Grounding-derived signal: which numbered atoms were actually SUPPLIED to
 * the prompt (independent of whether the model's prose happened to cite
 * them with a surviving [n] marker). Optional and additive — see
 * _decisions/2026-08-03_consumer_mode_citation_posture.md.
 */
export interface GroundingInfo {
  /** Count of atoms in the grounding record (delivered-and-eligible sources). */
  atomCount: number;
  /** How the record was produced. "supplied-atoms" today; room for a future
   * post-hoc relevance filter without a wire break. */
  method: "supplied-atoms";
}

export interface ResearchChatResult {
  message: string;
  messageHtml: string;
  /** Pro-mode inline citations (backward compatible). */
  citations: NumberedCitation[];
  /**
   * Consumer contract: technical sources for “See sources” / “For your
   * agent”. Populated from the GROUNDING record (atoms actually supplied to
   * the prompt) in every presentation mode, unioned with any marker-parsed
   * citations pro mode also produced — never solely a marker-survival
   * artifact. See _decisions/2026-08-03_consumer_mode_citation_posture.md.
   */
  sources: NumberedCitation[];
  /** Optional grounding metadata behind `sources`. Cheap, additive. */
  grounding?: GroundingInfo;
  disclaimer: string;
  confidence: number;
  generatedAt: string;
  method: "grok" | "anthropic" | "rules-v1";
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

/**
 * Build the grounding-derived numbered-source record: every atom that was
 * actually SUPPLIED to the prompt (the same `atoms` array numberedAtomBlock
 * rendered), independent of whether the model's prose cited it with a
 * surviving [n] marker. This is what makes consumer-mode `sources`
 * non-empty even though consumer prose is forbidden from carrying markers —
 * per _decisions/2026-08-03_consumer_mode_citation_posture.md, the sources
 * array reflects what grounded the answer, not what the model happened to
 * cite in text.
 *
 * Deliberately does NOT attempt to detect whether the model's answer
 * actually USED a given atom's content (that would require a second LLM
 * pass or semantic diffing); "supplied and eligible" is the honest claim
 * this method can back today. If atoms-used later proves systematically
 * over-broad (claims grounding the text doesn't reflect), the reversal
 * criteria in the decision record apply.
 */
function buildGroundingRecord(atoms: BriefAtomInput[]): {
  sources: NumberedCitation[];
  grounding: GroundingInfo;
} {
  const sources: NumberedCitation[] = atoms.map((a, i) => ({
    n: i + 1,
    atomDid: a.atomDid,
    label: a.label ?? `Source ${i + 1}`,
    snippet: a.snippet?.slice(0, 280),
    ...(a.sourceUrl ? { sourceUrl: a.sourceUrl } : {}),
    ...(a.entityId ? { entityId: a.entityId } : {}),
    ...(a.did ? { did: a.did } : {}),
    ...(a.webSearchBackup
      ? {
          disclosure: a.webSearchBackup.disclosure,
          source: "websearch" as const,
          confidence: a.webSearchBackup.confidence,
          retrievedAt: a.webSearchBackup.retrievedAt,
        }
      : {}),
  }));
  return {
    sources,
    grounding: { atomCount: sources.length, method: "supplied-atoms" },
  };
}

/**
 * ESTIMATE-CLASS v1 — an asserted-not-earned confidence estimate derived
 * from what actually grounded the answer (grounding atom count + retrieval
 * strength, when scores are available, + whether the subject-parcel-facts
 * entry is present), replacing the 0.75/0.5 marker-survival proxy this
 * function retires. This is NOT a calibrated probability: no outcome
 * feedback loop feeds it yet (commitment #2's calibration arrow is a later
 * build). It is a documented, reproducible formula so the number means the
 * same thing every time, versus an arbitrary constant.
 *
 * Formula (all constants named, tunable, no claimed precision beyond one
 * significant figure):
 *   - BASE_NO_GROUNDING = 0.35: floor when zero atoms grounded the answer
 *     (still above 0 — an LLM answer with no sources is not automatically
 *     worthless, but must never look confident).
 *   - BASE_WITH_GROUNDING = 0.55: floor once at least one atom grounded
 *     the answer, before any strength/count adjustment.
 *   - COUNT_BONUS_PER_ATOM = 0.03, capped at COUNT_BONUS_CAP = 0.15: more
 *     grounding atoms (up to ~5) modestly raise confidence — a single
 *     matched section is weaker signal than five converging sections.
 *   - SCORE_BONUS_CAP = 0.15: when vector retrieval scores are present
 *     (0-1 range; lexical integer counts are excluded from this term since
 *     they are not on a comparable scale), the mean of AVAILABLE vector
 *     scores (clamped 0-1) contributes up to this much.
 *   - SUBJECT_PARCEL_BONUS = 0.05: the subject-parcel-facts entry (present
 *     when areaContext.subject resolved) is a strong, structured grounding
 *     signal distinct from retrieved code text; small additive bump when
 *     present alongside code grounding.
 *   - Result clamped to [0.1, 0.95] — never 0 (that is reserved for "no
 *     answer generated" paths) and never 1 (nothing here is verified
 *     against outcome yet).
 */
const CONFIDENCE_BASE_NO_GROUNDING = 0.35;
const CONFIDENCE_BASE_WITH_GROUNDING = 0.55;
const CONFIDENCE_COUNT_BONUS_PER_ATOM = 0.03;
const CONFIDENCE_COUNT_BONUS_CAP = 0.15;
const CONFIDENCE_SCORE_BONUS_CAP = 0.15;
const CONFIDENCE_SUBJECT_PARCEL_BONUS = 0.05;
const CONFIDENCE_MIN = 0.1;
const CONFIDENCE_MAX = 0.95;

/**
 * ASSERTED-NOT-EARNED. Separate scale from computeGroundingConfidence: this
 * fires only when no LLM completion is available (mock/offline mode), so
 * there is no generated answer to derive grounding strength from — these
 * are hand-picked constants, not a formula, and intentionally do not share
 * the grounded-mode scale above.
 */
const RULES_V1_FALLBACK_CONFIDENCE_WITH_ATOMS = 0.4;
const RULES_V1_FALLBACK_CONFIDENCE_NO_ATOMS = 0.1;

function computeGroundingConfidence(atoms: BriefAtomInput[]): number {
  const webOnly =
    atoms.length > 0 &&
    atoms.every(
      (a) =>
        a.webSearchBackup != null ||
        a.atomDid.startsWith("websearch:") ||
        a.atomDid.startsWith("reasoning:"),
    );
  if (webOnly) return 0.35;

  if (atoms.length === 0) return CONFIDENCE_BASE_NO_GROUNDING;

  let confidence = CONFIDENCE_BASE_WITH_GROUNDING;

  const countBonus = Math.min(
    atoms.length * CONFIDENCE_COUNT_BONUS_PER_ATOM,
    CONFIDENCE_COUNT_BONUS_CAP,
  );
  confidence += countBonus;

  // Vector-path scores are ~0-1 (1 - cosine_distance); lexical-path scores
  // are integer match counts on a different scale entirely and are excluded
  // here so they cannot spuriously inflate confidence.
  const vectorScores = atoms
    .filter((a) => a.retrievalMode === "vector" && typeof a.score === "number")
    .map((a) => Math.max(0, Math.min(1, a.score as number)));
  if (vectorScores.length > 0) {
    const meanScore =
      vectorScores.reduce((sum, s) => sum + s, 0) / vectorScores.length;
    confidence += meanScore * CONFIDENCE_SCORE_BONUS_CAP;
  }

  const hasSubjectParcelEntry = atoms.some(
    (a) => a.entityId && !a.sourceUrl,
  );
  if (hasSubjectParcelEntry) {
    confidence += CONFIDENCE_SUBJECT_PARCEL_BONUS;
  }

  return Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, confidence));
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
      ...(atom.sourceUrl ? { sourceUrl: atom.sourceUrl } : {}),
      ...(atom.entityId ? { entityId: atom.entityId } : {}),
      ...(atom.did ? { did: atom.did } : {}),
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

async function completeBriefingLlm(
  system: string,
  user: string,
): Promise<{ text: string | null; method: "grok" | "anthropic" }> {
  const bundle = await getBriefingLlmClient();
  if (!bundle) return { text: null, method: "grok" };

  if (bundle.kind === "grok") {
    const text = await bundle.client.completeChat({
      model: resolveGrokBriefingModel(),
      maxTokens: BRIEFING_GROK_MAX_TOKENS,
      system,
      user,
    });
    return { text, method: "grok" };
  }

  const response = await bundle.client.messages.create({
    model: BRIEFING_ANTHROPIC_MODEL,
    max_tokens: BRIEFING_GROK_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  const textBlock = response.content.find((block) => block.type === "text");
  const text =
    textBlock && textBlock.type === "text" ? textBlock.text.trim() : null;
  return { text: text || null, method: "anthropic" };
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
    "You are a Texas real estate agent diligence assistant for investor-radar.",
    hasPrivate
      ? "Use numbered code atom sources AND private recorded-restriction excerpts (P1, P2, …) when relevant. Private restrictions are CC&Rs/deed limits — not municipal code."
      : "Write a concise property brief reasoning summary using ONLY the numbered code atom sources provided.",
    "Foreground rehab-reality (what a gut rehab triggers in adopted code) and can-I-add-a-unit / ADU reasoning cited to the code set.",
    "Precedence/adjudication: if jurisdiction precedence is not wired in prod, say so explicitly — do not imply governing hierarchy that was not resolved.",
    "Use inline citations like [1], [2] that map to the source numbers.",
    "Never state an opinion of value or appraisal — cite inputs only.",
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

  const { text: raw, method: llmMethod } = await completeBriefingLlm(system, user);
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
      method: llmMethod,
    };
  } catch {
    const citations = parseInlineCitations(raw, atoms);
    return {
      headline: `Property brief for ${input.address}.`,
      paragraphsHtml: textToHtmlParagraphs(raw),
      citations,
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      generatedAt: input.finishedAt,
      method: llmMethod,
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

  const { text: raw, method: llmMethod } = await completeBriefingLlm(system, user);
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
      method: llmMethod,
    };
  } catch {
    return {
      headline: `Summary for ${input.address}`,
      html: textToHtmlParagraphs(raw),
      summary: raw.slice(0, 280),
      citations: parseInlineCitations(raw, atoms),
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      method: llmMethod,
    };
  }
}

function finalizeResearchChatAnswer(
  answer: string,
  atoms: BriefAtomInput[],
  presentationMode: PresentationMode,
  generatedAt: string,
  method: "grok" | "anthropic" | "rules-v1",
): ResearchChatResult {
  const citations = parseInlineCitations(answer, atoms);
  const consumer = presentationMode === "consumer";
  const plain = consumer ? stripInlineCitations(answer) : answer;

  // Grounding-derived sources: the atoms actually supplied to the prompt,
  // independent of marker survival. Populates `sources` in EVERY
  // presentation mode per the 2026-08-03 ruling. Pro mode's marker-parsed
  // `citations` stay unchanged (backward compatible); `sources` in pro mode
  // unions the grounding record with any marker-parsed citations so nothing
  // regresses for existing pro consumers of `sources`.
  const { sources: groundingSources, grounding } = buildGroundingRecord(atoms);
  const sources = consumer
    ? groundingSources
    : unionCitationsByN(groundingSources, citations);

  const confidence = computeGroundingConfidence(atoms);

  return {
    message: plain,
    messageHtml: textToHtmlParagraphs(plain),
    citations,
    sources,
    grounding,
    disclaimer: PROPERTY_BRIEF_DISCLAIMER,
    confidence,
    generatedAt,
    method,
    presentationMode,
  };
}

/** Union two NumberedCitation arrays by `n`, preferring the second list's
 * entry on collision (marker-parsed citations carry a truncated 280-char
 * snippet identical in shape to the grounding record, so collisions are
 * inert) and sorted by `n` ascending for a stable, readable order. */
function unionCitationsByN(
  base: NumberedCitation[],
  extra: NumberedCitation[],
): NumberedCitation[] {
  const byN = new Map<number, NumberedCitation>();
  for (const c of base) byN.set(c.n, c);
  for (const c of extra) byN.set(c.n, c);
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

export async function generateResearchChat(input: {
  address: string;
  jurisdiction: string | null;
  message: string;
  history: Array<{ role: string; content: string }>;
  atoms: BriefAtomInput[];
  siteContext?: BrokerageSiteContext;
  privateRestrictionsBlock?: string;
  areaContextBlock?: string;
  presentationMode?: PresentationMode;
}): Promise<ResearchChatResult> {
  const presentationMode = input.presentationMode ?? "consumer";
  const atoms = input.atoms.slice(0, 16);
  const hasPrivate = Boolean(input.privateRestrictionsBlock?.trim());
  const hasArea = Boolean(input.areaContextBlock?.trim());
  const historyBlock = input.history
    .slice(-8)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");

  const system = [
    "You are a Texas property intel assistant (lay-friendly Carfax-for-property).",
    presentationMode === "consumer"
      ? "Answer in plain English for a homebuyer. Do NOT include [n] citation markers or statute numbers in the answer text."
      : "Answer for a real estate professional. Cite with [n] inline matching source numbers.",
    hasArea
      ? "When map/area context lists multiple visible parcels, answer portfolio or neighborhood questions (rent strength, likely sellers, filter matches) using ONLY the parcel rows and filters provided — do not invent listings."
      : null,
    atoms.some(
      (a) =>
        a.webSearchBackup != null ||
        a.atomDid.startsWith("websearch:") ||
        a.atomDid.startsWith("reasoning:"),
    )
      ? "Sources whose id starts with websearch: or that carry a web-search disclosure are a labeled web-search backup, not a Hauska catalog atom. Do not present them as verified corpus. Never fabricate ICC or code body."
      : null,
    hasPrivate
      ? "Use numbered code sources and private recorded-restriction excerpts (P1, P2, …) when the question touches HOA/CC&R/deed limits. Private restrictions are not municipal code."
      : "Use ONLY the numbered code atom sources. Do not invent code.",
    "No compliance guarantees.",
    "Respond with JSON only: {\"answer\": string (plain text)}.",
  ]
    .filter(Boolean)
    .join(" ");

  const siteBlock = formatBrokerageContextForLlm({
    siteContext: input.siteContext,
    privateRestrictionsBlock: input.privateRestrictionsBlock,
  });

  const user = [
    hasArea ? `Focus: ${input.address} (map area)` : `Property: ${input.address}`,
    `Jurisdiction: ${input.jurisdiction ?? "unknown"}`,
    siteBlock ? `\n${siteBlock}` : "",
    input.areaContextBlock ? `\n${input.areaContextBlock}` : "",
    "",
    "Conversation:",
    historyBlock || "(none)",
    "",
    `User question: ${input.message}`,
    "",
    "Sources:",
    numberedAtomBlock(atoms),
  ].join("\n");

  const { text: raw, method: llmMethod } = await completeBriefingLlm(system, user);
  const generatedAt = new Date().toISOString();

  if (!raw) {
    const msg =
      atoms.length > 0
        ? `Based on the available code sources for ${input.address}, please review the cited provisions with city staff. I do not have enough grounded context to answer "${input.message}" in mock mode.`
        : `No code atoms are available for this jurisdiction. Confirm corpus coverage for ${input.jurisdiction ?? "this market"} before answering "${input.message}".`;
    // rules-v1 fallback: no LLM ran, so nothing actually grounded a
    // generated answer — sources stays empty (the atoms were AVAILABLE, not
    // consumed into a grounded response) and confidence uses its OWN scale,
    // deliberately separate from computeGroundingConfidence's grounded-mode
    // formula above. ASSERTED-NOT-EARNED: 0.4/0.1 are hand-picked constants
    // reflecting "atoms exist but no reasoning ran" vs "nothing at all",
    // not a calibrated estimate. Keep distinct from the grounding formula
    // so a future calibration pass can retire this scale independently.
    return {
      message: msg,
      messageHtml: `<p>${escapeHtml(msg)}</p>`,
      citations: [],
      sources: [],
      disclaimer: PROPERTY_BRIEF_DISCLAIMER,
      confidence: atoms.length > 0 ? RULES_V1_FALLBACK_CONFIDENCE_WITH_ATOMS : RULES_V1_FALLBACK_CONFIDENCE_NO_ATOMS,
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
      llmMethod,
    );
  } catch {
    return finalizeResearchChatAnswer(
      raw.trim(),
      atoms,
      presentationMode,
      generatedAt,
      llmMethod,
    );
  }
}
