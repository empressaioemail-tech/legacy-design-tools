/**
 * S5 — consequence-gated model routing (LABELED ASSERTED).
 *
 * Stronger model on high-consequence stratum; cheap model on routine.
 * Earned weights replace asserted routing after S3 lands.
 */

import type { ConsequenceAxis } from "@hauska/atom-contract/read-contract";
import { createConsequenceAxis } from "@hauska/atom-contract/read-contract";

/** F2 typed consequence fields on code-section atoms (cc-agent-E). */
export interface CodeSectionConsequenceMetadata {
  asce7RiskCategory?: "I" | "II" | "III" | "IV";
  ibcOccupancyGroup?: string;
  ibcImportanceFactor?: number;
  jurisdictionCode?: string;
}

export type ConsequenceStratum = ConsequenceAxis["stratum"];

const STRATUM_RANK: Record<ConsequenceStratum, number> = {
  routine: 0,
  elevated: 1,
  critical: 2,
  essential: 3,
};

export function stratumFromAsce7RiskCategory(
  category: CodeSectionConsequenceMetadata["asce7RiskCategory"],
): ConsequenceStratum {
  switch (category) {
    case "IV":
      return "essential";
    case "III":
      return "critical";
    case "II":
      return "routine";
    case "I":
      return "elevated";
    default:
      return "routine";
  }
}

export function deriveConsequenceAxisFromMetadata(
  metadata: CodeSectionConsequenceMetadata | null | undefined,
  assembledAt?: string,
): ConsequenceAxis {
  const at = assembledAt ?? new Date().toISOString();
  const category = metadata?.asce7RiskCategory ?? "II";
  return createConsequenceAxis({
    derivation: {
      source: metadata?.ibcOccupancyGroup
        ? "derived-composite"
        : "asce7-risk-category",
      asce7RiskCategory: category,
      ...(metadata?.ibcOccupancyGroup
        ? { ibcOccupancyGroup: metadata.ibcOccupancyGroup }
        : {}),
      ...(metadata?.ibcImportanceFactor != null
        ? { ibcImportanceFactor: metadata.ibcImportanceFactor }
        : {}),
      ...(metadata?.jurisdictionCode
        ? { jurisdictionCode: metadata.jurisdictionCode }
        : {}),
    },
    stratum: stratumFromAsce7RiskCategory(category),
    assertedAt: at,
  });
}

export function maxConsequenceStratum(
  sections: ReadonlyArray<{ consequence?: CodeSectionConsequenceMetadata | null }>,
): ConsequenceStratum {
  let max: ConsequenceStratum = "routine";
  for (const s of sections) {
    const axis = deriveConsequenceAxisFromMetadata(s.consequence);
    if (STRATUM_RANK[axis.stratum] > STRATUM_RANK[max]) {
      max = axis.stratum;
    }
  }
  return max;
}

export type ModelRoutingTier = "high" | "low";

export interface ConsequenceGatedRouteDecision {
  stratum: ConsequenceStratum;
  modelTier: ModelRoutingTier;
  /** Grok model id for this stratum — asserted routing, not earned. */
  grokModel: string;
  ensembleEnabled: boolean;
  routingProvenance: "asserted";
  label: string;
}

const HIGH_STRATA = new Set<ConsequenceStratum>([
  "elevated",
  "critical",
  "essential",
]);

export function resolveHighConsequenceGrokModel(): string {
  return (
    process.env.XAI_FINDING_HIGH_MODEL?.trim() ||
    process.env.XAI_MODEL?.trim() ||
    "grok-3"
  );
}

export function resolveLowConsequenceGrokModel(): string {
  return (
    process.env.XAI_FINDING_LOW_MODEL?.trim() ||
    process.env.XAI_FINDING_MODEL?.trim() ||
    process.env.XAI_MODEL?.trim() ||
    "grok-3-mini"
  );
}

export function resolveConsequenceEnsembleEnabled(): boolean {
  const raw = (process.env.AIR_FINDING_ENSEMBLE_HIGH_CONSEQUENCE ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Route finding generation to high or low model tier based on F2
 * consequence metadata on retrieved code sections.
 */
export function resolveConsequenceGatedRoute(
  sections: ReadonlyArray<{ consequence?: CodeSectionConsequenceMetadata | null }>,
): ConsequenceGatedRouteDecision {
  const stratum = maxConsequenceStratum(sections);
  const high = HIGH_STRATA.has(stratum);
  const ensembleEnabled = high && resolveConsequenceEnsembleEnabled();
  const grokModel = high
    ? resolveHighConsequenceGrokModel()
    : resolveLowConsequenceGrokModel();

  return {
    stratum,
    modelTier: high ? "high" : "low",
    grokModel,
    ensembleEnabled,
    routingProvenance: "asserted",
    label: high
      ? `Asserted routing — high-consequence stratum (${stratum})${ensembleEnabled ? ", ensemble" : ""}`
      : `Asserted routing — routine stratum`,
  };
}
