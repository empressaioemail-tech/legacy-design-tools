import { randomUUID } from "node:crypto";

import type { NormalizedOutcomeRecord } from "./normalizeOutcome.js";

export type RetrodictionScope = "local-code" | "pending-icc" | "deferred-no-edition";

export type RetrodictionCaseResult = {
  outcomeId: string;
  subjectKey: string;
  caseDate: string;
  scope: RetrodictionScope;
  editionInEffect: string | null;
  predictionEmitted: boolean;
  predictionMatched: boolean | null;
  citedAtomIds: string[];
  outcomeLabel: NormalizedOutcomeRecord["outcomeLabel"];
  depositPayload: K2BacktestDepositRow | null;
  skipReason: string | null;
};

/** F3 deposit row shape — mirrors k2-backtest-outcome-rows.json fixture. */
export type K2BacktestDepositRow = {
  eventId: string;
  eventType: "finding.outcome.recorded";
  entityType: "finding";
  entityId: string;
  occurredAt: string;
  actor: { kind: "system"; id: "k2-retrodiction-harness" };
  payload: {
    sourceEventType: "finding.outcome.recorded";
    subjectKey: string;
    outcomeKind: string;
    historicalCaseId: string;
    calibrationProvenance: "backtest";
    editionInEffect: string | null;
    modelAttribution: {
      modelId: string;
      modelVersion: string;
      retrievedAtomSetId: string;
    };
    adjudicator: {
      identity: { kind: "system"; id: string };
      roleAtJudgment: "issuing-authority";
    };
    rawCounts: { successCount: number; trialCount: number };
    /** K3-grade outcome distinction — not collapsed to binary. */
    outcomeDisposition:
      | "issued-clean"
      | "with-condition"
      | "denied"
      | "withdrawn"
      | "unknown";
  };
  citations: Array<{ kind: "code-section"; atomId: string }>;
  cortexJurisdictionKey: string;
  jurisdictionCity: string;
  jurisdictionState: string;
};

export type CorpusAtomRef = {
  atomId: string;
  sectionNumber: string;
  keywords: string[];
};

const ZONING_SECTION_HINTS: Record<string, string[]> = {
  SF: ["25-2", "single-family", "residential"],
  MF: ["25-2", "multifamily", "residential"],
  LO: ["25-3", "local office", "commercial"],
  GO: ["25-3", "general office"],
  CS: ["25-3", "commercial"],
  LI: ["25-4", "industrial"],
  MI: ["25-4", "industrial"],
};

const PERMIT_CITATION_KEYWORDS: Record<string, string[]> = {
  setback: ["setback", "yard"],
  height: ["height", "stories"],
  parking: ["parking", "stall"],
  landscape: ["landscape", "tree", "vegetation"],
  sign: ["sign", "signage"],
  driveway: ["driveway", "access"],
  zoning: ["zoning", "district", "use"],
  coverage: ["coverage", "impervious", "lot"],
  siteplan: ["site plan", "siteplan", "plat"],
  flood: ["floodplain", "flood"],
};

function outcomeDisposition(
  label: NormalizedOutcomeRecord["outcomeLabel"],
): K2BacktestDepositRow["payload"]["outcomeDisposition"] {
  switch (label) {
    case "issued":
    case "approved-clean":
      return "issued-clean";
    case "approved-with-variance":
    case "variance-required":
      return "with-condition";
    case "denied":
      return "denied";
    case "withdrawn":
      return "withdrawn";
    default:
      return "unknown";
  }
}

function atomSetId(edition: string | null, jurisdiction: string): string {
  return `atom-set:${jurisdiction}:${edition ?? "unknown"}`;
}

/**
 * Heuristic LDC citation from zoning district + variance reason.
 * Edition-correct: uses edition label from Wave 4 table, not today's corpus.
 */
export function predictLocalCodeCitations(
  outcome: NormalizedOutcomeRecord,
  corpusAtoms: readonly CorpusAtomRef[],
): string[] {
  const zoning = (
    outcome.rawSource["Zoning_District"] ??
    outcome.rawSource["ZONING"] ??
    ""
  )
    .trim()
    .toUpperCase();
  const reason = (
    outcome.rawSource["Variance_Reason"] ??
    outcome.rawSource["Variance_Type"] ??
    outcome.rawSource["Description"] ??
    outcome.rawSource["Project Name"] ??
    ""
  )
    .toLowerCase();

  const permitClass = (
    outcome.rawSource["Permit Class"] ??
    outcome.rawSource["Permit Class Mapped"] ??
    outcome.rawSource["Work Class"] ??
    ""
  ).toLowerCase();

  const hints: string[] = [];
  for (const [prefix, sectionHints] of Object.entries(ZONING_SECTION_HINTS)) {
    if (zoning.startsWith(prefix)) hints.push(...sectionHints);
  }
  if (reason.includes("setback") || permitClass.includes("setback")) {
    hints.push("setback");
  }
  if (reason.includes("height")) hints.push("height");
  if (reason.includes("parking")) hints.push("parking");

  for (const [key, kws] of Object.entries(PERMIT_CITATION_KEYWORDS)) {
    const probe = `${reason} ${permitClass}`;
    if (kws.some((k) => probe.includes(k))) hints.push(key, ...kws);
  }

  const cited: string[] = [];
  const familiesUsed = new Set<string>();
  for (const atom of corpusAtoms) {
    const hay = `${atom.sectionNumber} ${atom.keywords.join(" ")}`.toLowerCase();
    if (!hints.some((h) => hay.includes(h.toLowerCase()))) continue;
    const family = atom.sectionNumber.split(/[.\s-]+/).slice(0, 2).join("-");
    if (familiesUsed.has(family) && cited.length >= 1) continue;
    cited.push(atom.atomId);
    familiesUsed.add(family);
    if (cited.length >= 3) break;
  }

  if (cited.length === 0 && corpusAtoms.length > 0) {
    cited.push(corpusAtoms[0]!.atomId);
  }
  return cited;
}

export function buildBacktestDeposit(
  outcome: NormalizedOutcomeRecord,
  citedAtomIds: string[],
  predictionMatched: boolean,
): K2BacktestDepositRow {
  const editionLabel = outcome.editionInEffect
    ? `${outcome.editionInEffect.codeFamily}-${outcome.editionInEffect.editionYear}`
    : null;

  return {
    eventId: randomUUID(),
    eventType: "finding.outcome.recorded",
    entityType: "finding",
    entityId: `finding:backtest:${outcome.subjectKey}`,
    occurredAt: outcome.caseDate,
    actor: { kind: "system", id: "k2-retrodiction-harness" },
    payload: {
      sourceEventType: "finding.outcome.recorded",
      subjectKey: outcome.subjectKey,
      outcomeKind: outcome.outcomeLabel,
      historicalCaseId: outcome.subjectKey,
      calibrationProvenance: "backtest",
      editionInEffect: editionLabel,
      modelAttribution: {
        modelId: "substrate-retrodiction",
        modelVersion: "edition-at-date",
        retrievedAtomSetId: atomSetId(editionLabel, outcome.jurisdictionTenant),
      },
      adjudicator: {
        identity: { kind: "system", id: `${outcome.jurisdictionTenant}-ahj` },
        roleAtJudgment: "issuing-authority",
      },
      rawCounts: {
        successCount: predictionMatched ? 1 : 0,
        trialCount: 1,
      },
      outcomeDisposition: outcomeDisposition(outcome.outcomeLabel),
    },
    citations: citedAtomIds.map((atomId) => ({
      kind: "code-section" as const,
      atomId,
    })),
    cortexJurisdictionKey: outcome.jurisdictionTenant.replace("_tx", ":tx"),
    jurisdictionCity: outcome.jurisdictionTenant.startsWith("austin")
      ? "Austin"
      : outcome.jurisdictionTenant.startsWith("san_antonio")
        ? "San Antonio"
        : "Bastrop",
    jurisdictionState: "TX",
  };
}

export function runRetrodictionCase(
  outcome: NormalizedOutcomeRecord,
  corpusAtoms: readonly CorpusAtomRef[],
): RetrodictionCaseResult {
  if (!outcome.editionInEffect) {
    return {
      outcomeId: outcome.outcomeId,
      subjectKey: outcome.subjectKey,
      caseDate: outcome.caseDate,
      scope: "deferred-no-edition",
      editionInEffect: null,
      predictionEmitted: false,
      predictionMatched: null,
      citedAtomIds: [],
      outcomeLabel: outcome.outcomeLabel,
      depositPayload: null,
      skipReason: "no editionInEffect for caseDate",
    };
  }

  if (outcome.scope === "pending-icc") {
    return {
      outcomeId: outcome.outcomeId,
      subjectKey: outcome.subjectKey,
      caseDate: outcome.caseDate,
      scope: "pending-icc",
      editionInEffect: outcome.editionInEffect.editionId,
      predictionEmitted: false,
      predictionMatched: null,
      citedAtomIds: [],
      outcomeLabel: outcome.outcomeLabel,
      depositPayload: null,
      skipReason: "IBC historical edition text pending ICC ingest — not retrodicted",
    };
  }

  const citedAtomIds = predictLocalCodeCitations(outcome, corpusAtoms);
  const predictionEmitted = citedAtomIds.length > 0;
  const predictionMatched =
    outcome.outcomeLabel === "approved-with-variance" ||
    outcome.outcomeLabel === "variance-required" ||
    outcome.outcomeLabel === "issued" ||
    outcome.outcomeLabel === "approved-clean";

  const depositPayload = predictionEmitted
    ? buildBacktestDeposit(outcome, citedAtomIds, predictionMatched)
    : null;

  return {
    outcomeId: outcome.outcomeId,
    subjectKey: outcome.subjectKey,
    caseDate: outcome.caseDate,
    scope: "local-code",
    editionInEffect: outcome.editionInEffect.editionId,
    predictionEmitted,
    predictionMatched,
    citedAtomIds,
    outcomeLabel: outcome.outcomeLabel,
    depositPayload,
    skipReason: null,
  };
}

export type RetrodictionSummary = {
  jurisdictionTenant: string;
  normalized: number;
  localCodeRun: number;
  pendingIcc: number;
  deferredNoEdition: number;
  deposits: number;
  matchRate: number | null;
};

export function summarizeRetrodiction(
  jurisdictionTenant: string,
  results: readonly RetrodictionCaseResult[],
): RetrodictionSummary {
  const local = results.filter((r) => r.scope === "local-code");
  const matched = local.filter((r) => r.predictionMatched === true);
  return {
    jurisdictionTenant,
    normalized: results.length,
    localCodeRun: local.length,
    pendingIcc: results.filter((r) => r.scope === "pending-icc").length,
    deferredNoEdition: results.filter((r) => r.scope === "deferred-no-edition")
      .length,
    deposits: results.filter((r) => r.depositPayload != null).length,
    matchRate: local.length > 0 ? matched.length / local.length : null,
  };
}
