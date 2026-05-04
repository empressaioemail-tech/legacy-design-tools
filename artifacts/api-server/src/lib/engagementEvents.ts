/**
 * Best-effort emitters for engagement-domain lifecycle events.
 *
 * Three producers live here:
 *   - `engagement.address-updated`: emitted when the engagement's stored
 *     address transitions to a different value. Producer is the PATCH
 *     /engagements/:id route (the only entry point that mutates the
 *     stored address — snapshot ingest is sticky on rebind).
 *   - `engagement.jurisdiction-resolved`: emitted when a successful
 *     geocode yields a new jurisdiction city/state pair (or moves the
 *     previously-resolved pair to a different one). Producers are the
 *     PATCH /engagements/:id and POST /engagements/:id/geocode route
 *     handlers AND the snapshot-ingest's async `fireGeocodeAndWarmup`
 *     post-create-new geocode pass.
 *   - `engagement.submitted`: emitted when a plan-review package is
 *     submitted to the jurisdiction. Producer is the POST
 *     /engagements/:id/submissions route. As of Task #63 the route
 *     persists a row in the `submissions` table and uses that row's
 *     id as the event payload's `submissionId` — the row is the
 *     source of truth, this event is the audit-trail surface. The
 *     payload shape is unchanged from the pre-table version so any
 *     consumers wired against the original event keep working.
 *
 * All three follow the same "best-effort" contract used by
 * `emitSnapshotLifecycleEvents` and `emitEngagementCreatedEvent` in
 * `routes/snapshots.ts`: failures are caught and logged so a transient
 * history outage cannot roll back the underlying row update — events
 * are observability, rows are the source of truth (locked decision #5).
 *
 * Event-type literals are pinned to {@link EngagementEventType} so a
 * rename in `engagement.atom.ts`'s `ENGAGEMENT_EVENT_TYPES` makes these
 * fail to compile rather than silently emit a stale name.
 */

import type { EventAnchoringService } from "@workspace/empressa-atom";
import type { Logger } from "pino";
import type { SubmissionStatus } from "@workspace/db";
import { keyFromEngagement } from "@workspace/codes";
import {
  DECISION_RECORDED_ACTOR_ID,
  ENGAGEMENT_EDIT_ACTOR_ID,
  SNAPSHOT_INGEST_ACTOR_ID,
  SUBMISSION_INGEST_ACTOR_ID,
} from "@workspace/server-actor-ids";
import type { EngagementEventType } from "../atoms/engagement.atom";
import type { SubmissionEventType } from "../atoms/submission.atom";
import type {
  DecisionEventEventType,
  DecisionVerdict,
} from "../atoms/decision-event.atom";

const ENGAGEMENT_ADDRESS_UPDATED_EVENT_TYPE: EngagementEventType =
  "engagement.address-updated";
const ENGAGEMENT_JURISDICTION_RESOLVED_EVENT_TYPE: EngagementEventType =
  "engagement.jurisdiction-resolved";
const ENGAGEMENT_SUBMITTED_EVENT_TYPE: EngagementEventType =
  "engagement.submitted";
const ENGAGEMENT_IFC_INGESTED_EVENT_TYPE: EngagementEventType =
  "engagement.ifc-ingested";
const SUBMISSION_STATUS_CHANGED_EVENT_TYPE: SubmissionEventType =
  "submission.status-changed";
const DECISION_EVENT_RECORDED_EVENT_TYPE: DecisionEventEventType =
  "decision-event.recorded";

/**
 * Stable system actor for engagement lifecycle events emitted from the
 * REST routes (PATCH + regeocode). The PATCH endpoint is not yet wired
 * to a session-bound user identity, so the actor is the route itself —
 * mirrors the snapshot-ingest's `snapshot-ingest` actor convention. The
 * snapshot-ingest's own actor for the async post-create-new geocode
 * pass continues to live in `routes/snapshots.ts` alongside the other
 * snapshot lifecycle emitters; this file only owns the engagement-edit
 * one so import graphs do not collide on the same constant.
 */
export const ENGAGEMENT_EDIT_ACTOR = {
  kind: "system" as const,
  id: ENGAGEMENT_EDIT_ACTOR_ID,
};

/**
 * Stable system actor for `engagement.submitted` events emitted by the
 * submission create route. Distinct from `engagement-edit` (PATCH /
 * regeocode) so the timeline can attribute submissions to the
 * submission ingest path rather than the engagement-edit surface, even
 * before there is a dedicated user-bound identity to attach to the
 * event. Mirrors the snapshot ingest's `snapshot-ingest` actor
 * convention in `routes/snapshots.ts`.
 */
export const SUBMISSION_INGEST_ACTOR = {
  kind: "system" as const,
  id: SUBMISSION_INGEST_ACTOR_ID,
};

/**
 * Stable system actor for `decision-event.recorded` events emitted
 * by the PLR-6 decisions route as a defensive fallback when the
 * route's session has no bound reviewer requestor id. The route is
 * gated on `audience: "internal"` (which usually carries one), so
 * this actor only shows up on the unlikely fallback path — but
 * exists so the audit trail still attributes the verdict to
 * *something* stable.
 */
export const DECISION_RECORDED_ACTOR = {
  kind: "system" as const,
  id: DECISION_RECORDED_ACTOR_ID,
};

export interface EngagementEventActor {
  kind: "user" | "agent" | "system";
  id: string;
}

/**
 * Append an `engagement.address-updated` event. Caller is responsible
 * for the prior/new comparison — this helper just emits whatever it is
 * handed. The stored address is normalized to `null` when absent or
 * empty so the payload is comparable across calls.
 */
export async function emitEngagementAddressUpdatedEvent(
  history: EventAnchoringService,
  params: {
    engagementId: string;
    fromAddress: string | null;
    toAddress: string | null;
    actor: EngagementEventActor;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: params.engagementId,
      eventType: ENGAGEMENT_ADDRESS_UPDATED_EVENT_TYPE,
      actor: params.actor,
      payload: {
        fromAddress: params.fromAddress,
        toAddress: params.toAddress,
      },
    });
    reqLog.info(
      {
        engagementId: params.engagementId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.address-updated event appended",
    );
  } catch (err) {
    reqLog.error(
      { err, engagementId: params.engagementId },
      "engagement.address-updated event append failed — row update kept",
    );
  }
}

/**
 * Append an `engagement.jurisdiction-resolved` event when a geocode
 * has produced a new jurisdiction city/state pair. The "new" guard is
 * applied here so callers can call this unconditionally after every
 * geocode without re-emitting the same resolution: when the structured
 * `(city, state)` matches the prior pair (or the geocode produced no
 * city/state at all), the function is a no-op.
 *
 * The payload includes the structured city/state/fips so downstream
 * consumers (timeline UI, audit exports) can render the resolution
 * without joining back to the engagement row, plus the canonical
 * `jurisdictionKey` derived via the same `keyFromEngagement` registry
 * the warmup queue uses (null when the resolved city/state is not a
 * registered jurisdiction). The previous (city, state, key) trio is
 * also included so the diff is self-contained.
 */
export async function emitEngagementJurisdictionResolvedEvent(
  history: EventAnchoringService,
  params: {
    engagementId: string;
    jurisdictionCity: string | null;
    jurisdictionState: string | null;
    jurisdictionFips: string | null;
    previousJurisdictionCity: string | null;
    previousJurisdictionState: string | null;
    actor: EngagementEventActor;
  },
  reqLog: Logger,
): Promise<void> {
  const city = params.jurisdictionCity?.trim() || null;
  const state = params.jurisdictionState?.trim() || null;
  if (!city || !state) return;
  const prevCity = params.previousJurisdictionCity?.trim() || null;
  const prevState = params.previousJurisdictionState?.trim() || null;
  if (city === prevCity && state === prevState) return;
  // Derive the canonical jurisdiction key the same way the warmup
  // queue does (`keyFromEngagement` in `@workspace/codes`). Returns
  // null when the resolved city/state is not a registered jurisdiction
  // — that's still useful audit information ("we resolved a city/state
  // but it's not one we have code-source coverage for") so the field
  // is always emitted, distinguishing "no jurisdiction at all" (the
  // function would have early-returned above) from "jurisdiction not
  // registered for warmup".
  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: city,
    jurisdictionState: state,
  });
  const previousJurisdictionKey =
    prevCity && prevState
      ? keyFromEngagement({
          jurisdictionCity: prevCity,
          jurisdictionState: prevState,
        })
      : null;
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: params.engagementId,
      eventType: ENGAGEMENT_JURISDICTION_RESOLVED_EVENT_TYPE,
      actor: params.actor,
      payload: {
        jurisdictionKey,
        jurisdictionCity: city,
        jurisdictionState: state,
        jurisdictionFips: params.jurisdictionFips,
        previousJurisdictionKey,
        previousJurisdictionCity: prevCity,
        previousJurisdictionState: prevState,
      },
    });
    reqLog.info(
      {
        engagementId: params.engagementId,
        jurisdictionKey,
        jurisdictionCity: city,
        jurisdictionState: state,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.jurisdiction-resolved event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        engagementId: params.engagementId,
        jurisdictionKey,
        jurisdictionCity: city,
        jurisdictionState: state,
      },
      "engagement.jurisdiction-resolved event append failed — row update kept",
    );
  }
}

/**
 * Append an `engagement.submitted` event against the parent engagement
 * when a plan-review package is submitted to the jurisdiction. Closes
 * out the engagement event vocabulary declared in
 * {@link import("../atoms/engagement.atom").ENGAGEMENT_EVENT_TYPES}.
 *
 * The payload is intentionally self-contained — it carries the
 * jurisdiction labels and submission note alongside the
 * `submissionId` — so consumers (timeline UI, audit exports) can
 * render the entry without joining back to the `submissions` row.
 * The `submissionId` field points at the row created by the route
 * handler in `routes/engagements.ts` (Task #63); the payload shape is
 * identical to the pre-row version of this helper so consumers wired
 * against the original event keep working.
 *
 * Best-effort by the same contract as the sibling helpers: failures
 * are caught and logged so a transient history outage cannot fail the
 * submission HTTP request.
 */
export async function emitEngagementSubmittedEvent(
  history: EventAnchoringService,
  params: {
    engagementId: string;
    submissionId: string;
    jurisdiction: string | null;
    jurisdictionCity: string | null;
    jurisdictionState: string | null;
    note: string | null;
    actor: EngagementEventActor;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: params.engagementId,
      eventType: ENGAGEMENT_SUBMITTED_EVENT_TYPE,
      actor: params.actor,
      payload: {
        submissionId: params.submissionId,
        jurisdiction: params.jurisdiction,
        jurisdictionCity: params.jurisdictionCity,
        jurisdictionState: params.jurisdictionState,
        note: params.note,
      },
    });
    reqLog.info(
      {
        engagementId: params.engagementId,
        submissionId: params.submissionId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.submitted event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        engagementId: params.engagementId,
        submissionId: params.submissionId,
      },
      "engagement.submitted event append failed — submission HTTP response kept",
    );
  }
}

/**
 * Append a `submission.status-changed` event scoped to a submission
 * entity. Producer is the PLR-6 decisions route in
 * `routes/decisions.ts` — emitted whenever a recorded verdict moves
 * the submission's `status` column to a new value (and on no-op
 * re-records, so the timeline preserves the audit entry).
 *
 * Distinct from `decision-event.recorded` (which lives on the
 * `decision-event` chain) so the per-submission timeline UI can read
 * a clean stream of status transitions (`{fromStatus, toStatus,
 * note}`) without having to derive transitions from the heterogeneous
 * decision-event payload.
 *
 * Best-effort by the same contract as the sibling helpers — a
 * transient history outage cannot fail the decision HTTP request.
 */
/**
 * Append a `decision-event.recorded` event scoped to a `decision-event`
 * entity (one row per decision; entityId is a freshly-minted UUID
 * generated by the route layer). Producer is the PLR-6 decisions
 * route in `routes/decisions.ts`.
 *
 * Anchoring against the `decision-event` entity (rather than the
 * parent submission) keeps each verdict on its own short, append-only
 * chain — the `contextSummary` of the `decision-event` atom can then
 * load it back by `(entityType, entityId)` without scanning the
 * submission's broader event history. The submission's own status
 * timeline still receives a companion `submission.status-changed`
 * event from the route via {@link emitSubmissionStatusChangedEvent},
 * so the per-submission timeline does not regress.
 *
 * Best-effort by the same contract as the sibling helpers — failures
 * are caught and logged so a transient history outage cannot fail
 * the decision HTTP request. Returns the appended event so the route
 * layer can forward its `id` / `recordedAt` straight into the
 * response body.
 */
export async function emitDecisionEventRecordedEvent(
  history: EventAnchoringService,
  params: {
    decisionId: string;
    submissionId: string;
    engagementId: string;
    verdict: DecisionVerdict;
    comment: string | null;
    actor: EngagementEventActor;
  },
  reqLog: Logger,
): Promise<{ id: string; occurredAt: Date } | null> {
  try {
    const event = await history.appendEvent({
      entityType: "decision-event",
      entityId: params.decisionId,
      eventType: DECISION_EVENT_RECORDED_EVENT_TYPE,
      actor: params.actor,
      payload: {
        submissionId: params.submissionId,
        engagementId: params.engagementId,
        verdict: params.verdict,
        comment: params.comment,
      },
    });
    reqLog.info(
      {
        decisionId: params.decisionId,
        submissionId: params.submissionId,
        verdict: params.verdict,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "decision-event.recorded event appended",
    );
    return { id: event.id, occurredAt: event.occurredAt };
  } catch (err) {
    reqLog.error(
      {
        err,
        decisionId: params.decisionId,
        submissionId: params.submissionId,
        verdict: params.verdict,
      },
      "decision-event.recorded event append failed — submission update kept",
    );
    return null;
  }
}

export async function emitSubmissionStatusChangedEvent(
  history: EventAnchoringService,
  params: {
    submissionId: string;
    engagementId: string;
    fromStatus: SubmissionStatus;
    toStatus: SubmissionStatus;
    note: string | null;
    occurredAt: Date;
    actor: EngagementEventActor;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "submission",
      entityId: params.submissionId,
      eventType: SUBMISSION_STATUS_CHANGED_EVENT_TYPE,
      actor: params.actor,
      // Anchor the event to the caller-supplied transition time
      // (the route passes `respondedAt`) rather than the append
      // wall-clock so the Status History timeline sorts correctly
      // for back-dated recordings and matches the row's
      // `respondedAt` exactly.
      occurredAt: params.occurredAt,
      payload: {
        engagementId: params.engagementId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        note: params.note,
        occurredAt: params.occurredAt.toISOString(),
      },
    });
    reqLog.info(
      {
        submissionId: params.submissionId,
        engagementId: params.engagementId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "submission.status-changed event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        submissionId: params.submissionId,
        engagementId: params.engagementId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
      },
      "submission.status-changed event append failed — row update kept",
    );
  }
}

/**
 * Track B/C — `engagement.ifc-ingested`. Emitted by `lib/ifcIngest.ts`
 * after a Revit-side IFC export has parsed cleanly and the per-entity
 * + bundle `materializable_elements` rows have committed alongside
 * the consolidated glTF cache. Surfaces "as-built model arrived" on
 * the engagement timeline so the architect / reviewer can see the
 * new geometry without polling the BIM card by hand.
 *
 * Best-effort, like the rest of the engagement-event helpers: a
 * history outage logs and returns; the underlying ingest's row writes
 * are the source of truth and stay committed.
 *
 * Actor: `snapshot-ingest` — the IFC arrives via the same multipart
 * push from the Revit add-in that delivers sheet snapshots, so the
 * timeline attribution mirrors `engagement.snapshot-received`.
 */
export const SNAPSHOT_INGEST_ACTOR = {
  kind: "system" as const,
  id: SNAPSHOT_INGEST_ACTOR_ID,
};

export async function emitEngagementIfcIngestedEvent(
  history: EventAnchoringService,
  params: {
    engagementId: string;
    snapshotId: string;
    ifcFileId: string;
    entityCount: number;
    ifcVersion: string | null;
  },
  reqLog: Logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: params.engagementId,
      eventType: ENGAGEMENT_IFC_INGESTED_EVENT_TYPE,
      actor: SNAPSHOT_INGEST_ACTOR,
      payload: {
        snapshotId: params.snapshotId,
        ifcFileId: params.ifcFileId,
        entityCount: params.entityCount,
        ifcVersion: params.ifcVersion,
      },
    });
    reqLog.info(
      {
        engagementId: params.engagementId,
        snapshotId: params.snapshotId,
        ifcFileId: params.ifcFileId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.ifc-ingested event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        engagementId: params.engagementId,
        snapshotId: params.snapshotId,
        ifcFileId: params.ifcFileId,
      },
      "engagement.ifc-ingested event append failed — row writes kept",
    );
  }
}
