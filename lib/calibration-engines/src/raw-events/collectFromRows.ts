import { resolveJurisdictionTenant } from "./tenant";
import { eventKindForType, parseRichLedgerPayload } from "./parseRichLedger";
import type {
  CollectRawCalibrationEventsOptions,
  RawCalibrationEvent,
  RawCalibrationEventCollection,
  RawCalibrationJoinRow,
} from "./types";

function isCodeSectionCitation(
  c: unknown,
): c is { kind: "code-section"; atomId: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { kind?: unknown }).kind === "code-section" &&
    typeof (c as { atomId?: unknown }).atomId === "string" &&
    (c as { atomId: string }).atomId.length > 0
  );
}

export function extractCodeCitationAtomIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const ids: string[] = [];
  for (const c of citations) {
    if (isCodeSectionCitation(c)) ids.push(c.atomId);
  }
  return ids;
}

function parseStatedConfidence(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseActor(actor: unknown): { kind: string; id: string } {
  if (typeof actor !== "object" || actor === null) {
    return { kind: "unknown", id: "unknown" };
  }
  const kind =
    typeof (actor as { kind?: unknown }).kind === "string"
      ? (actor as { kind: string }).kind
      : "unknown";
  const id =
    typeof (actor as { id?: unknown }).id === "string"
      ? (actor as { id: string }).id
      : "unknown";
  return { kind, id };
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

/**
 * Pure read-time join over pre-fetched ledger rows — used by fixture tests and
 * by the DB-backed collector.
 */
export function projectRawCalibrationEventsFromRows(
  rows: readonly RawCalibrationJoinRow[],
  options?: CollectRawCalibrationEventsOptions,
): RawCalibrationEventCollection {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;
  const atomFilter = (options?.citedAtomId ?? "").trim() || null;

  const events: RawCalibrationEvent[] = [];
  let phase1OnlyCount = 0;

  for (const row of rows) {
    if (row.entityType !== "finding") continue;

    const kind = eventKindForType(row.eventType);
    if (!kind) continue;

    const tenant = resolveJurisdictionTenant(row);
    if (!tenant) continue;
    if (tenantFilter && tenant !== tenantFilter) continue;

    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    if (citedAtomIds.length === 0) continue;
    if (atomFilter && !citedAtomIds.includes(atomFilter)) continue;

    const payload = payloadRecord(row.payload);
    const rich = parseRichLedgerPayload(payload, row.eventType);
    if (rich.phase1Only) phase1OnlyCount += 1;

    events.push({
      eventId: row.eventId,
      occurredAt: toIsoString(row.occurredAt),
      kind,
      eventType: row.eventType,
      findingAtomId: row.entityId,
      jurisdictionTenant: tenant,
      citedAtomIds,
      actor: parseActor(row.actor),
      payload,
      sourceEventType: rich.sourceEventType,
      subjectKey: rich.subjectKey ?? row.entityId,
      adjudicator: rich.adjudicator,
      modelAttribution: rich.modelAttribution,
      rawCounts: rich.rawCounts,
      outcomeKind: rich.outcomeKind,
      historicalCaseId: rich.historicalCaseId,
      calibrationFuelProvenance: rich.calibrationFuelProvenance,
      statedConfidence: parseStatedConfidence(row.statedConfidenceRaw),
    });
  }

  events.sort((a, b) => {
    const timeCmp = a.occurredAt.localeCompare(b.occurredAt);
    if (timeCmp !== 0) return timeCmp;
    return a.eventId.localeCompare(b.eventId);
  });

  return { events, phase1OnlyCount };
}
