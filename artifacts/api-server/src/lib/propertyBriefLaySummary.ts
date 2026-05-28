/**
 * Lay (consumer) summary helpers for Property Brief responses.
 */

import type { BrokerageSiteContext } from "./brokerageSiteContext";
import type { BriefAtomInput } from "./brokerageBriefLlm";
import { getBriefingLlmClient } from "./briefingLlmClient";
import {
  resolveGrokBriefingModel,
  BRIEFING_GROK_MAX_TOKENS,
} from "@workspace/briefing-engine";

export type LayVerdictStatus = "yes" | "maybe" | "no" | "unknown";

export type PresentationMode = "consumer" | "pro";

export interface LayVerdict {
  id: string;
  label: string;
  status: LayVerdictStatus;
  oneLine: string;
  detailParagraph: string;
}

export interface LaySummaryResult {
  verdicts: LayVerdict[];
  presentationMode: PresentationMode;
  generatedAt: string;
  method: "grok" | "rules-v1";
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripInlineCitations(text: string): string {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function floodLayerSummary(siteContext?: BrokerageSiteContext): string | null {
  const layer = siteContext?.layers.find(
    (l) =>
      l.layerKind.includes("flood") ||
      l.adapterKey.includes("fema") ||
      l.summary?.toLowerCase().includes("flood"),
  );
  return layer?.summary ?? null;
}

function hasAtomTopic(atoms: BriefAtomInput[], needles: RegExp): boolean {
  return atoms.some(
    (a) =>
      needles.test(a.label ?? "") ||
      needles.test(a.snippet ?? "") ||
      needles.test(a.atomDid ?? ""),
  );
}

export function buildRulesLaySummary(input: {
  address: string;
  jurisdiction: string | null;
  corpusStatus: string;
  atoms: BriefAtomInput[];
  siteContext?: BrokerageSiteContext;
  presentationMode: PresentationMode;
  finishedAt: string;
}): LaySummaryResult {
  const floodSummary = floodLayerSummary(input.siteContext);
  const inCorpus =
    input.corpusStatus === "in_corpus" || input.corpusStatus === "partial";
  const aduHit = hasAtomTopic(input.atoms, /adu|accessory|dwelling/i);
  const strHit = hasAtomTopic(input.atoms, /str|short.?term|rental/i);
  const setbackHit = hasAtomTopic(input.atoms, /setback|addition|pool/i);

  const verdicts: LayVerdict[] = [
    {
      id: "adu",
      label: "ADU / guest house",
      status: !inCorpus ? "unknown" : aduHit ? "maybe" : "unknown",
      oneLine: !inCorpus
        ? "We do not have enough local code coverage to say yet."
        : aduHit
          ? "Local rules mention ADUs — zoning still needs a city check."
          : "No clear ADU rules surfaced in our search.",
      detailParagraph: !inCorpus
        ? "Hauska could not match this address to a fully indexed city code library. Ask your agent or city planning before assuming an ADU is allowed."
        : aduHit
          ? "Adopted code snippets reference accessory dwelling rules. Lot size, zoning district, and utility capacity still matter — confirm with Bastrop planning before promising a guest house."
          : "Our standard property-intel scan did not pull strong ADU provisions. That does not prove ADUs are banned — only that we did not find a clear hit.",
    },
    {
      id: "flood",
      label: "Flood risk",
      status: floodSummary
        ? /zone\s*[a-z]|high.?risk|special flood/i.test(floodSummary)
          ? "maybe"
          : "yes"
        : "unknown",
      oneLine: floodSummary
        ? floodSummary.includes("AE") || /high/i.test(floodSummary)
          ? "FEMA maps show elevated flood exposure — budget for insurance."
          : "Flood layer data is available; review the map with your agent."
        : "Flood data was not available for this lookup.",
      detailParagraph: floodSummary
        ? `Federal flood mapping indicates: ${floodSummary}. Insurance requirements and building rules can differ by lender — verify before closing.`
        : "We could not retrieve a FEMA flood summary for this pin. Your agent can pull an official flood determination.",
    },
    {
      id: "major_restrictions",
      label: "Major restrictions",
      status: !inCorpus ? "unknown" : strHit || setbackHit ? "maybe" : "unknown",
      oneLine: !inCorpus
        ? "Code coverage is limited — treat restrictions as unknown."
        : strHit || setbackHit
          ? "Setbacks, rentals, or pool rules may limit what you can do."
          : "No major restriction flags jumped out in our scan.",
      detailParagraph: !inCorpus
        ? "Without full city code coverage we cannot summarize setback, STR, or pool rules reliably. Use See sources or ask your agent for a zoning letter."
        : "Standard buyer topics (setbacks, short-term rental, pools, major additions) returned some code hits. Specific lot zoning still controls what applies.",
    },
    {
      id: "corpus_coverage",
      label: "Local code coverage",
      status:
        input.corpusStatus === "in_corpus"
          ? "yes"
          : input.corpusStatus === "partial"
            ? "maybe"
            : "no",
      oneLine:
        input.corpusStatus === "in_corpus"
          ? "Hauska has adopted-code coverage for this city."
          : input.corpusStatus === "partial"
            ? "Partial code coverage — some topics may be missing."
            : "This city is not fully indexed in Hauska yet.",
      detailParagraph:
        input.corpusStatus === "in_corpus"
          ? `We indexed adopted municipal code for ${input.jurisdiction ?? "this market"}. This is a research aid, not a permit approval.`
          : input.corpusStatus === "partial"
            ? "Some code sections are indexed but the library may be incomplete. Treat gaps as “verify with city staff.”"
            : "Property intel works best in Corpus-backed Texas metros. For this address, lean on your agent and official city records.",
    },
  ];

  return {
    verdicts,
    presentationMode: input.presentationMode,
    generatedAt: input.finishedAt,
    method: "rules-v1",
  };
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

export async function generateLaySummary(input: {
  address: string;
  jurisdiction: string | null;
  corpusStatus: string;
  atoms: BriefAtomInput[];
  siteContext?: BrokerageSiteContext;
  presentationMode: PresentationMode;
  finishedAt: string;
}): Promise<LaySummaryResult> {
  const floodSummary = floodLayerSummary(input.siteContext);
  const system = [
    "You write lay-friendly property intel for homebuyers (Carfax-for-property style).",
    "NO statute numbers, NO atom IDs, NO legal jargon dumps.",
    "Each verdict uses plain English with implied confidence in status.",
    "status must be one of: yes, maybe, no, unknown.",
    "Cover at minimum these verdict ids: adu, flood, major_restrictions, corpus_coverage.",
    "For flood: use site context when provided; if no flood data, status=unknown.",
    "For corpus_coverage: be honest about in_corpus/partial/no_match.",
    'Respond JSON only: {"verdicts":[{"id":string,"label":string,"status":"yes"|"maybe"|"no"|"unknown","oneLine":string,"detailParagraph":string}]}',
  ].join(" ");

  const siteLines =
    input.siteContext?.layers
      .map((l) => `${l.layerKind}: ${l.summary ?? l.status}`)
      .join("\n") ?? "(none)";

  const user = [
    `Address: ${input.address}`,
    `Jurisdiction: ${input.jurisdiction ?? "unknown"}`,
    `Corpus status: ${input.corpusStatus}`,
    `Flood context: ${floodSummary ?? "not available"}`,
    "Site layers:",
    siteLines,
    "",
    "Code topic hints (do not quote verbatim):",
    input.atoms
      .slice(0, 8)
      .map((a) => `- ${a.label ?? "topic"}: ${(a.snippet ?? "").slice(0, 200)}`)
      .join("\n"),
  ].join("\n");

  const raw = await completeGrok(system, user);
  if (!raw) {
    return buildRulesLaySummary(input);
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? raw) as {
      verdicts?: Array<{
        id?: string;
        label?: string;
        status?: string;
        oneLine?: string;
        detailParagraph?: string;
      }>;
    };
    const statuses = new Set(["yes", "maybe", "no", "unknown"]);
    const verdicts: LayVerdict[] = (parsed.verdicts ?? [])
      .filter((v) => v.id && v.label)
      .map((v) => ({
        id: v.id!,
        label: v.label!,
        status: statuses.has(v.status ?? "")
          ? (v.status as LayVerdictStatus)
          : "unknown",
        oneLine: v.oneLine?.trim() || "Needs verification with your agent.",
        detailParagraph:
          v.detailParagraph?.trim() ||
          "See sources or ask your agent for the official record.",
      }));

    if (verdicts.length < 3) {
      return buildRulesLaySummary(input);
    }

    return {
      verdicts,
      presentationMode: input.presentationMode,
      generatedAt: input.finishedAt,
      method: "grok",
    };
  } catch {
    return buildRulesLaySummary(input);
  }
}

export function layHtmlFromVerdicts(verdicts: LayVerdict[]): string {
  return verdicts
    .map(
      (v) =>
        `<p><strong>${escapeHtml(v.label)} — ${escapeHtml(v.status.toUpperCase())}</strong> ${escapeHtml(v.oneLine)}</p>`,
    )
    .join("");
}
