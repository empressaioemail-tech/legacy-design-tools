/**
 * Read-time join over F3 rich ledger rows (+ K2 backtest deposits when present).
 *
 * This module never writes derived numbers. It mirrors the join in
 * `atomAdjudicationEvidenceLedger.ts` and cc-agent-C's `signals.ts`, but
 * emits one normalized raw event per ledger row instead of aggregated tallies
 * or overlay materialization.
 */

import {
  db,
  atomEvents,
  findings,
  submissions,
  engagements,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { projectRawCalibrationEventsFromRows } from "./collectFromRows";
import type {
  CollectRawCalibrationEventsOptions,
  RawCalibrationEventCollection,
  RawCalibrationJoinRow,
} from "./types";

const COLLECTED_EVENT_TYPES = [
  "finding.accepted",
  "finding.rejected",
  "finding.overridden",
  "finding.outcome.recorded",
] as const;

export async function collectRawCalibrationEvents(
  options?: CollectRawCalibrationEventsOptions,
): Promise<RawCalibrationEventCollection> {
  const rows = await db
    .select({
      eventId: atomEvents.id,
      eventType: atomEvents.eventType,
      entityType: atomEvents.entityType,
      entityId: atomEvents.entityId,
      occurredAt: atomEvents.occurredAt,
      actor: atomEvents.actor,
      payload: atomEvents.payload,
      citations: findings.citations,
      statedConfidenceRaw: findings.confidence,
      cortexJurisdictionKey: engagements.cortexJurisdictionKey,
      jurisdictionCity: engagements.jurisdictionCity,
      jurisdictionState: engagements.jurisdictionState,
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
    })
    .from(atomEvents)
    .innerJoin(findings, eq(findings.atomId, atomEvents.entityId))
    .innerJoin(submissions, eq(submissions.id, findings.submissionId))
    .innerJoin(engagements, eq(engagements.id, submissions.engagementId))
    .where(
      and(
        eq(atomEvents.entityType, "finding"),
        inArray(atomEvents.eventType, [...COLLECTED_EVENT_TYPES]),
      ),
    );

  return projectRawCalibrationEventsFromRows(
    rows as RawCalibrationJoinRow[],
    options,
  );
}
