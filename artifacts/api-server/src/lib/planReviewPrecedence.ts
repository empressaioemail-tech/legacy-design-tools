/**
 * Plan-review BFF precedence helpers — lives outside routes/ so the
 * engine-spine ungated-path audit (ADR-008) stays satisfied.
 */
import {
  isPrecedenceEngineProductionEnabled,
  precedenceReconciliationsFromCodeSections,
} from "@workspace/finding-engine";
import type { CodeSectionInput } from "@workspace/finding-engine";

export { isPrecedenceEngineProductionEnabled };

export type PrecedenceResultWire = {
  topic: string;
  ruleApplied: string;
  governingAtomId: string;
  comparedAtomIds: string[];
};

export function precedenceResultsFromCodeSections(
  codeSections: ReadonlyArray<CodeSectionInput>,
): PrecedenceResultWire[] {
  if (!isPrecedenceEngineProductionEnabled()) return [];
  const { reconciliations } =
    precedenceReconciliationsFromCodeSections(codeSections);
  return reconciliations.map((rec) => ({
    topic: rec.topic,
    ruleApplied: rec.ruleApplied,
    governingAtomId: rec.governing.atomId,
    comparedAtomIds: rec.compared.map((c) => c.atomId),
  }));
}
