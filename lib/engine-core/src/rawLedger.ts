/**
 * F3 — rich raw ledger payload stamps (Calibrated Spine).
 *
 * Append-only atom_events payloads carry raw signal only. Derived
 * quantities (posterior, agreement, calibrated point) are never persisted.
 */

import type { ModelAttributionStamp } from "@hauska/atom-contract/read-contract";

/** Canonical source-event-type for ledger deposits. */
export type LedgerSourceEventType =
  | "finding.generated"
  | "finding.accepted"
  | "finding.rejected"
  | "finding.overridden"
  | "finding.outcome.recorded"
  | "briefing.generated"
  | "synthesis.conflict"
  | "warming.ping";

export interface AdjudicatorAtJudgment {
  identity: { kind: "user" | "agent" | "system"; id: string };
  /** Role at time of judgment — e.g. reviewer, plan-review-engine. */
  roleAtJudgment: string;
}

/** Success/trial counts at finest grain (per subject + event). */
export interface RawCountStamp {
  successCount: number;
  trialCount: number;
}

/**
 * Rich ledger payload extension merged into atom_events.payload.
 * Never include derived calibration numbers — only raw inputs.
 */
export interface RichLedgerPayload {
  sourceEventType: LedgerSourceEventType;
  /** Stable subject key (finding atom id, place key, synthesis id). */
  subjectKey: string;
  adjudicator?: AdjudicatorAtJudgment;
  modelAttribution?: ModelAttributionStamp;
  rawCounts?: RawCountStamp;
  /** LLM- or extract-model self-reported confidence — raw signal only. */
  rawModelConfidence?: number;
  /** Opaque extension fields from the producer (findingId, generationId, …). */
  [key: string]: unknown;
}

export function buildRichLedgerPayload(
  base: Record<string, unknown>,
  stamp: {
    sourceEventType: LedgerSourceEventType;
    subjectKey: string;
    adjudicator?: AdjudicatorAtJudgment;
    modelAttribution?: ModelAttributionStamp;
    rawCounts?: RawCountStamp;
    rawModelConfidence?: number;
  },
): RichLedgerPayload {
  return {
    ...base,
    sourceEventType: stamp.sourceEventType,
    subjectKey: stamp.subjectKey,
    ...(stamp.adjudicator ? { adjudicator: stamp.adjudicator } : {}),
    ...(stamp.modelAttribution
      ? { modelAttribution: stamp.modelAttribution }
      : {}),
    ...(stamp.rawCounts ? { rawCounts: stamp.rawCounts } : {}),
    ...(stamp.rawModelConfidence != null
      ? { rawModelConfidence: stamp.rawModelConfidence }
      : {}),
  };
}

export function adjudicatorFromActor(
  actor: { kind: "user" | "agent" | "system"; id: string },
  roleAtJudgment: string,
): AdjudicatorAtJudgment {
  return {
    identity: { kind: actor.kind, id: actor.id },
    roleAtJudgment,
  };
}
