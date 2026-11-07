import { eq } from "drizzle-orm";
import {
  db,
  gtmConsent,
  gtmEventRefusals,
  gtmEvents,
  type GtmEventPayload,
} from "@workspace/db";
import { logger } from "./logger";
import {
  decideGtmEventWrite,
  type GtmConsentSnapshot,
} from "./recordGtmEventDecide";

export { decideGtmEventWrite, type GtmConsentSnapshot } from "./recordGtmEventDecide";

export const GTM_CONSENT_VERSION = "2026-05-26-v1";

export type RecordGtmEventInput = {
  installId: string;
  eventType: string;
  sourceSurface?: string;
  runId?: string | null;
  listingKey?: string | null;
  personaInferred?: string | null;
  payload?: GtmEventPayload;
};

/**
 * Fire-and-forget server-internal GTM event writer; never throws to callers.
 *
 * P-100 item 5. Consent is RESOLVED FROM `gtm_consent`, never defaulted and
 * never taken from the caller. `consentVersion` and `graphOptIn` were removed
 * from the input type on purpose: they were the only way a call site could
 * assert its own consent state, and a caller-asserted consent version is a
 * client claim wearing a server type. The reasoning, the measured cost, and
 * the sentinel case are in `recordGtmEventDecide.ts`.
 *
 * A REFUSAL IS RECORDED. When no consent exists for the install, the event is
 * not written and a row lands in `gtm_event_refusals` naming the event type,
 * the install, the surface, the reason and the time. Without that record a
 * refused rail and an idle rail are the same observation, and the whole point
 * of refusing rather than defaulting is that somebody can see the hole.
 *
 * This is NOT the writer for the two consent-enforcing HTTP routes
 * (`POST /gtm/events`, `POST /gtm/property-explorer/events`). Those already
 * refuse 403 without a consent row and stamp the version from the store, and
 * they insert directly. Three insert sites into `gtm_events` existed before
 * this change and three exist after it; no writer was added.
 */
export function recordGtmEvent(input: RecordGtmEventInput): void {
  const sourceSurface = input.sourceSurface ?? "api";

  void (async () => {
    const [row] = await db
      .select({
        consentVersion: gtmConsent.consentVersion,
        graphOptIn: gtmConsent.graphOptIn,
      })
      .from(gtmConsent)
      .where(eq(gtmConsent.installId, input.installId))
      .limit(1);

    const snapshot: GtmConsentSnapshot = row
      ? { consentVersion: row.consentVersion, graphOptIn: row.graphOptIn }
      : null;

    const decision = decideGtmEventWrite(snapshot);

    if (decision.action === "refuse") {
      await db.insert(gtmEventRefusals).values({
        installId: input.installId,
        eventType: input.eventType,
        sourceSurface,
        reason: decision.reason,
      });
      logger.warn(
        {
          eventType: input.eventType,
          installId: input.installId,
          reason: decision.reason,
        },
        "gtm: event REFUSED and recorded (no consent for install)",
      );
      return;
    }

    await db.insert(gtmEvents).values({
      installId: input.installId,
      eventType: input.eventType,
      sourceSurface,
      runId: input.runId ?? null,
      listingKey: input.listingKey ?? null,
      personaInferred: input.personaInferred ?? null,
      consentVersion: decision.consentVersion,
      graphOptIn: decision.graphOptIn,
      payloadJson: input.payload ?? {},
    });

    logger.debug(
      { eventType: input.eventType, installId: input.installId },
      "gtm: event recorded",
    );
  })().catch((err) => {
    // The write path failed (network, pool, constraint). This is the one
    // place a silent drop is still possible, and it is logged at warn with
    // the event type so it is not invisible. It is NOT converted into a
    // refusal row: a refusal means "this system declined", and a database
    // outage is not a decision.
    logger.warn(
      { err, eventType: input.eventType },
      "gtm: failed to record event or refusal",
    );
  });
}
