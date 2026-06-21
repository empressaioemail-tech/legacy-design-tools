import type {
  AdjudicatorAtJudgmentPartial,
  CalibrationFuelProvenance,
  ModelAttributionStampPartial,
  RawCountStamp,
} from "./types";

const ADJUDICATION_EVENT_TYPES = new Set([
  "finding.accepted",
  "finding.rejected",
  "finding.overridden",
]);

const OUTCOME_EVENT_TYPE = "finding.outcome.recorded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseModelAttribution(
  payload: Record<string, unknown>,
): ModelAttributionStampPartial | undefined {
  const direct = payload.modelAttribution;
  if (!isRecord(direct)) return undefined;
  const stamp: ModelAttributionStampPartial = {};
  const modelId = readString(direct, "modelId");
  const modelVersion = readString(direct, "modelVersion");
  const promptTemplateVersion = readString(direct, "promptTemplateVersion");
  const contextTemplateVersion = readString(direct, "contextTemplateVersion");
  const retrievedAtomSetId = readString(direct, "retrievedAtomSetId");
  if (modelId) stamp.modelId = modelId;
  if (modelVersion) stamp.modelVersion = modelVersion;
  if (promptTemplateVersion) stamp.promptTemplateVersion = promptTemplateVersion;
  if (contextTemplateVersion) {
    stamp.contextTemplateVersion = contextTemplateVersion;
  }
  if (retrievedAtomSetId) stamp.retrievedAtomSetId = retrievedAtomSetId;
  if (isRecord(direct.samplingParams)) {
    stamp.samplingParams = direct.samplingParams;
  }
  return Object.keys(stamp).length > 0 ? stamp : undefined;
}

function parseAdjudicator(
  payload: Record<string, unknown>,
): AdjudicatorAtJudgmentPartial | undefined {
  const direct = payload.adjudicator;
  if (!isRecord(direct)) return undefined;
  const roleAtJudgment = readString(direct, "roleAtJudgment");
  const identityRaw = direct.identity;
  const identity = isRecord(identityRaw)
    ? {
        kind: readString(identityRaw, "kind"),
        id: readString(identityRaw, "id"),
      }
    : undefined;
  if (!roleAtJudgment && !identity?.id) return undefined;
  return { identity, roleAtJudgment };
}

function parseRawCounts(payload: Record<string, unknown>): RawCountStamp | undefined {
  const direct = payload.rawCounts;
  if (!isRecord(direct)) return undefined;
  const successCount = direct.successCount;
  const trialCount = direct.trialCount;
  if (
    typeof successCount !== "number" ||
    typeof trialCount !== "number" ||
    !Number.isFinite(successCount) ||
    !Number.isFinite(trialCount)
  ) {
    return undefined;
  }
  return { successCount, trialCount };
}

export function parseCalibrationFuelProvenance(
  payload: Record<string, unknown>,
): CalibrationFuelProvenance {
  const candidates = [
    payload.calibrationProvenance,
    payload.provenance,
    payload.fuelProvenance,
  ];
  for (const value of candidates) {
    if (value === "backtest" || value === "seed" || value === "live") {
      return value;
    }
    if (value === "asserted") return "asserted";
  }
  return "unknown";
}

export function eventKindForType(eventType: string): "adjudication" | "outcome" | null {
  if (ADJUDICATION_EVENT_TYPES.has(eventType)) return "adjudication";
  if (eventType === OUTCOME_EVENT_TYPE) return "outcome";
  return null;
}

/** True when F3 rich stamps are present on the payload. */
export function hasRichLedgerStamp(payload: Record<string, unknown>): boolean {
  return Boolean(
    readString(payload, "sourceEventType") ||
      readString(payload, "subjectKey") ||
      parseAdjudicator(payload) ||
      parseModelAttribution(payload) ||
      parseRawCounts(payload),
  );
}

export interface ParsedRichLedgerFields {
  sourceEventType?: string;
  subjectKey?: string;
  adjudicator?: AdjudicatorAtJudgmentPartial;
  modelAttribution?: ModelAttributionStampPartial;
  rawCounts?: RawCountStamp;
  outcomeKind?: string;
  historicalCaseId?: string;
  calibrationFuelProvenance: CalibrationFuelProvenance;
  phase1Only: boolean;
}

export function parseRichLedgerPayload(
  payload: Record<string, unknown>,
  eventType: string,
): ParsedRichLedgerFields {
  const calibrationFuelProvenance = parseCalibrationFuelProvenance(payload);
  const rich = hasRichLedgerStamp(payload);
  return {
    sourceEventType: readString(payload, "sourceEventType") ?? eventType,
    subjectKey: readString(payload, "subjectKey"),
    adjudicator: parseAdjudicator(payload),
    modelAttribution: parseModelAttribution(payload),
    rawCounts: parseRawCounts(payload),
    outcomeKind: readString(payload, "outcomeKind"),
    historicalCaseId: readString(payload, "historicalCaseId"),
    calibrationFuelProvenance:
      eventType === OUTCOME_EVENT_TYPE && calibrationFuelProvenance === "unknown"
        ? "live"
        : calibrationFuelProvenance,
    phase1Only: !rich,
  };
}
