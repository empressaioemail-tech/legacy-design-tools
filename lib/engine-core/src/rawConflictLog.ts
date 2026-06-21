/**
 * F5 — raw-conflict log. Record disagreeing synthesis inputs with
 * provenance and vintage; derive conflict type at read (no frozen enum).
 */

import type { LedgerSourceEventType } from "./rawLedger.js";

export const SYNTHESIS_CONFLICT_EVENT_TYPE = "synthesis.conflict" as const satisfies LedgerSourceEventType;

/** One disagreeing input frozen at synthesis time. */
export interface RawConflictInput {
  atomId: string;
  provenance: string;
  /** ISO-8601 data vintage or edition label. */
  vintage: string | null;
  /** Human-readable summary of the disagreeing value. */
  valueSummary: string;
}

export interface RawConflictLogPayload {
  sourceEventType: typeof SYNTHESIS_CONFLICT_EVENT_TYPE;
  subjectKey: string;
  disagreeingInputs: RawConflictInput[];
  /** Atom id or label of the resolved output, if any. */
  resolvedOutputRef?: string | null;
  synthesisDomain?: string;
}

export function buildRawConflictLogPayload(args: {
  subjectKey: string;
  disagreeingInputs: RawConflictInput[];
  resolvedOutputRef?: string | null;
  synthesisDomain?: string;
}): RawConflictLogPayload {
  return {
    sourceEventType: SYNTHESIS_CONFLICT_EVENT_TYPE,
    subjectKey: args.subjectKey,
    disagreeingInputs: args.disagreeingInputs,
    ...(args.resolvedOutputRef != null
      ? { resolvedOutputRef: args.resolvedOutputRef }
      : {}),
    ...(args.synthesisDomain ? { synthesisDomain: args.synthesisDomain } : {}),
  };
}

/**
 * Derive conflict type at read from raw inputs — no stored enum.
 * Returns a descriptive string for operator surfaces.
 */
export function deriveConflictTypeAtRead(
  inputs: readonly RawConflictInput[],
): string {
  if (inputs.length < 2) return "insufficient-inputs";
  const vintages = new Set(
    inputs.map((i) => i.vintage ?? "unknown").filter(Boolean),
  );
  if (vintages.size > 1) return "cross-vintage-disagreement";
  const provenances = new Set(inputs.map((i) => i.provenance));
  if (provenances.size > 1) return "cross-source-disagreement";
  return "same-vintage-value-disagreement";
}
