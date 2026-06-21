/**
 * F5 — append raw-conflict events to the evidence ledger.
 */

import type { EventAnchoringService } from "@hauska/atom-contract";
import type { CodeSectionInput } from "@workspace/finding-engine";
import { precedenceReconciliationsFromCodeSections } from "@workspace/finding-engine";
import {
  buildRawConflictLogPayload,
  deriveConflictTypeAtRead,
  type RawConflictInput,
} from "@workspace/engine-core";

function conflictInputsFromReconciliation(
  rec: {
    compared: ReadonlyArray<{
      atomId: string;
      citationLabel: string;
      numericValue?: number;
      numericUnit?: string;
      standardLabel: string;
    }>;
    conflicts: ReadonlyArray<{ competingAtomIds: readonly string[] }>;
    evaluatedAt: Date;
  },
  codeSections: ReadonlyArray<CodeSectionInput>,
): RawConflictInput[] {
  const sectionByAtom = new Map(codeSections.map((s) => [s.atomId, s]));
  return rec.compared.map((req) => {
    const section = sectionByAtom.get(req.atomId);
    const valueSummary =
      req.numericValue != null
        ? `${req.numericValue}${req.numericUnit ?? ""} (${req.standardLabel})`
        : req.citationLabel;
    return {
      atomId: req.atomId,
      provenance: section?.webProvenance?.sourceUrl ?? req.standardLabel,
      vintage:
        section?.webProvenance?.retrievedAt ??
        rec.evaluatedAt.toISOString(),
      valueSummary,
    };
  });
}

export async function logPrecedenceConflictsFromCodeSections(
  history: EventAnchoringService,
  args: {
    subjectKey: string;
    codeSections: ReadonlyArray<CodeSectionInput>;
  },
): Promise<number> {
  const { reconciliations } = precedenceReconciliationsFromCodeSections(
    args.codeSections,
  );
  let logged = 0;
  for (const rec of reconciliations) {
    if (rec.conflicts.length === 0 && rec.compared.length < 2) continue;
    const disagreeingInputs = conflictInputsFromReconciliation(rec, args.codeSections);
    if (disagreeingInputs.length < 2) continue;
    await appendRawConflictLogEvent(history, {
      subjectKey: `${args.subjectKey}:${rec.topic}`,
      disagreeingInputs,
      resolvedOutputRef: rec.governing.atomId,
      synthesisDomain: "accessibility-precedence",
    });
    logged += 1;
  }
  return logged;
}

export async function appendRawConflictLogEvent(
  history: EventAnchoringService,
  args: {
    subjectKey: string;
    disagreeingInputs: RawConflictInput[];
    resolvedOutputRef?: string | null;
    synthesisDomain?: string;
  },
): Promise<{ eventId: string; derivedConflictType: string }> {
  const payload = buildRawConflictLogPayload(args);
  const event = await history.appendEvent({
    entityType: "synthesis-conflict",
    entityId: args.subjectKey,
    eventType: "synthesis.conflict",
    actor: { kind: "system", id: "cortex-api:synthesis" },
    payload: {
      ...payload,
      derivedConflictType: deriveConflictTypeAtRead(args.disagreeingInputs),
    },
  });
  return {
    eventId: event.id,
    derivedConflictType: deriveConflictTypeAtRead(args.disagreeingInputs),
  };
}
