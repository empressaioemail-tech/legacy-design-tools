/**
 * P-98 next-action rail — the activation event WRITER.
 *
 * The query half. The validator (`./peActivationEventsValidate`) imports no
 * database and holds the closed sets; this file only writes what that
 * validator already accepted.
 *
 * There is exactly one writer of `pe_activation_events` and it is this
 * function, reached only from `POST /property-explorer/v1/activation-events`
 * behind `requirePeAuthenticated`. That matters for the DDL asymmetry
 * recorded in migration 0091: `action_id` is not value-checked in the
 * database because this route is the only path to the table, and a raw
 * connection writing an unknown id is a state nothing produces today. If a
 * second writer ever appears, that reasoning expires with it.
 */

import { db, peActivationEvents } from "@workspace/db";

import type { PeActivationEventInput } from "./peActivationEventsValidate";

export {
  PE_ACTIVATION_ACTION_IDS,
  PE_ACTIVATION_EVENT_TYPES,
  parseActivationEvent,
  type PeActivationActionId,
  type PeActivationEventInput,
  type PeActivationEventParse,
  type PeActivationEventTypeValue,
} from "./peActivationEventsValidate";

export type PeActivationEventRecorded = {
  eventType: string;
  actionId: string;
  surface: string | null;
  createdAt: string;
};

/**
 * Record one activation event and return what was actually stored.
 *
 * The row is echoed back from `returning()` rather than from the input, so
 * the response reports the persisted `created_at` (the database's clock, the
 * one every later ratio is bucketed by) instead of a value this process
 * guessed. `surface` comes back as stored: `null` means the caller sent none,
 * and it is never filled in.
 */
export async function recordActivationEvent(
  ownerUserId: string,
  input: PeActivationEventInput,
): Promise<PeActivationEventRecorded> {
  const [row] = await db
    .insert(peActivationEvents)
    .values({
      ownerUserId,
      eventType: input.eventType,
      actionId: input.actionId,
      surface: input.surface,
    })
    .returning({
      eventType: peActivationEvents.eventType,
      actionId: peActivationEvents.actionId,
      surface: peActivationEvents.surface,
      createdAt: peActivationEvents.createdAt,
    });

  // An INSERT ... RETURNING that returns no row means the write did not
  // happen. Reporting success here would be the fabricated-measurement
  // defect this table exists to avoid, so it raises instead.
  if (!row) {
    throw new Error("pe_activation_events insert returned no row");
  }

  return {
    eventType: row.eventType,
    actionId: row.actionId,
    surface: row.surface ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
