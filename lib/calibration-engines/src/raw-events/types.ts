/**
 * Raw calibration event shapes — read-only, never persisted by this package.
 *
 * Mirrors F3 rich-ledger fields from cc-agent-C's deposit loop. Optional
 * fields tolerate Phase-1 rows that lack full stamps.
 */

/** Fuel provenance tag carried on outcome / backtest deposits. */
export type CalibrationFuelProvenance =
  | "asserted"
  | "backtest"
  | "seed"
  | "live"
  | "unknown";

export type RawCalibrationEventKind = "adjudication" | "outcome";

/** Partial model-attribution stamp — full shape lands with F3 on main. */
export interface ModelAttributionStampPartial {
  modelId?: string;
  modelVersion?: string;
  promptTemplateVersion?: string;
  contextTemplateVersion?: string;
  retrievedAtomSetId?: string;
  samplingParams?: Record<string, unknown>;
}

export interface AdjudicatorAtJudgmentPartial {
  identity?: { kind?: string; id?: string };
  roleAtJudgment?: string;
}

export interface RawCountStamp {
  successCount: number;
  trialCount: number;
}

/** One atom_events row joined to finding + engagement context. */
export interface RawCalibrationJoinRow {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  occurredAt: Date | string;
  actor: unknown;
  payload: unknown;
  citations: unknown;
  /** findings.confidence — input feature only, never a calibration anchor. */
  statedConfidenceRaw?: string | null;
  cortexJurisdictionKey?: string | null;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
}

/**
 * Normalized raw event emitted by the collector. Downstream engines (K3, S1…)
 * derive posteriors and widthed confidence at read time — never written back.
 */
export interface RawCalibrationEvent {
  eventId: string;
  occurredAt: string;
  kind: RawCalibrationEventKind;
  eventType: string;
  findingAtomId: string;
  jurisdictionTenant: string;
  citedAtomIds: string[];
  actor: { kind: string; id: string };
  payload: Record<string, unknown>;
  /** F3 optional — absent on Phase-1 ledger rows. */
  sourceEventType?: string;
  subjectKey?: string;
  adjudicator?: AdjudicatorAtJudgmentPartial;
  modelAttribution?: ModelAttributionStampPartial;
  rawCounts?: RawCountStamp;
  outcomeKind?: string;
  historicalCaseId?: string;
  calibrationFuelProvenance: CalibrationFuelProvenance;
  /** LLM-stated finding confidence — never used as calibration anchor. */
  statedConfidence: number | null;
}

export interface CollectRawCalibrationEventsOptions {
  jurisdictionTenant?: string | null;
  /** When set, only events citing this code/reasoning atom id are returned. */
  citedAtomId?: string | null;
}

export interface RawCalibrationEventCollection {
  events: RawCalibrationEvent[];
  /** Phase-1 rows missing F3 rich stamps — informational for health routes. */
  phase1OnlyCount: number;
}
