import { db, gtmEvents, type GtmEventPayload } from "@workspace/db";
import { logger } from "./logger";

export const GTM_CONSENT_VERSION = "2026-05-26-v1";

export type RecordGtmEventInput = {
  installId: string;
  eventType: string;
  sourceSurface?: string;
  runId?: string | null;
  listingKey?: string | null;
  personaInferred?: string | null;
  consentVersion?: string | null;
  graphOptIn?: boolean | null;
  payload?: GtmEventPayload;
};

/** Fire-and-forget; never throws to callers. */
export function recordGtmEvent(input: RecordGtmEventInput): void {
  const row = {
    installId: input.installId,
    eventType: input.eventType,
    sourceSurface: input.sourceSurface ?? "api",
    runId: input.runId ?? null,
    listingKey: input.listingKey ?? null,
    personaInferred: input.personaInferred ?? null,
    consentVersion: input.consentVersion ?? null,
    graphOptIn:
      input.graphOptIn === null || input.graphOptIn === undefined
        ? null
        : input.graphOptIn
          ? "true"
          : "false",
    payloadJson: input.payload ?? {},
  };

  void db
    .insert(gtmEvents)
    .values(row)
    .then(() => {
      logger.debug(
        { eventType: input.eventType, installId: input.installId },
        "gtm: event recorded",
      );
    })
    .catch((err) => {
      logger.warn(
        { err, eventType: input.eventType },
        "gtm: failed to record event",
      );
    });
}
