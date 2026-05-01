/**
 * Best-effort emitters for engagement-domain lifecycle events.
 *
 * Two producers live here:
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
 *
 * Both follow the same "best-effort" contract used by
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
import { keyFromEngagement } from "@workspace/codes";
import type { EngagementEventType } from "../atoms/engagement.atom";

const ENGAGEMENT_ADDRESS_UPDATED_EVENT_TYPE: EngagementEventType =
  "engagement.address-updated";
const ENGAGEMENT_JURISDICTION_RESOLVED_EVENT_TYPE: EngagementEventType =
  "engagement.jurisdiction-resolved";

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
  id: "engagement-edit",
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
