/**
 * Production entry: enqueue a lifecycle event and try THIS row once.
 *
 * The user path never awaits a send's success and never drains anyone
 * else's rows (P-492 3b): it claims only the row it just wrote. Anything that
 * does not go through now is retried by the scheduled drain
 * (`peLifecycleDrain.ts`), not by the next user's request.
 */

import { db as prodDb } from "@workspace/db";
import { logger } from "./logger";
import {
  drizzleOutboxStore,
  loadResendSubject,
  markResendSegment,
  projectOutboxRowToContact,
  resendEventName,
} from "./peLifecycleOutbox.drizzle";
import {
  assertPaidEventFromWebhook,
  enqueueLifecycleEvent,
  processLifecycleOutbox,
  type EnqueueInput,
  type LegDeps,
  type MetaLegResult,
  type OutboxRecord,
} from "./peLifecycleOutbox";
import { META_REFUSED_BY_NAME, sendMetaCapiEvent } from "./peMetaCapi";
import { sendLifecycleToResend } from "./peResendLifecycle";

type Db = typeof prodDb;

async function metaLeg(row: OutboxRecord, now: Date): Promise<MetaLegResult> {
  const value = row.payload["value"];
  const currency = row.payload["currency"];
  const m = await sendMetaCapiEvent({
    event: row.eventType,
    eventId: row.id,
    email: row.email,
    eventTime: Math.floor(now.getTime() / 1000),
    value: typeof value === "number" ? value : undefined,
    currency: typeof currency === "string" ? currency : undefined,
  });
  if (m.ok) return { ok: true };
  return {
    ok: false,
    error: m.error,
    refusedByName: (META_REFUSED_BY_NAME as readonly string[]).includes(m.error),
  };
}

/** The real legs: ss_contact projection, Resend, Meta. */
export function productionLegDeps(db: Db = prodDb): LegDeps {
  return {
    project: (row) => projectOutboxRowToContact(row, db),
    sendMeta: (row) => metaLeg(row, new Date()),
    sendResend: async (row, resendEvent) => {
      const subject = await loadResendSubject(row, db);
      if (!subject) return { ok: false, error: "resend_subject_missing" };
      const r = await sendLifecycleToResend({
        subject,
        event: resendEventName(row.eventType),
        eventPayload: resendEvent,
      });
      if (!r.ok) return r;
      if (r.addedToSegment && row.subject.kind === "user") {
        await markResendSegment(row.subject.userId, db);
      }
      return { ok: true };
    },
  };
}

export async function dispatchLifecycleEvent(
  input: EnqueueInput & { source?: string },
): Promise<string | null> {
  try {
    assertPaidEventFromWebhook(input.event, input.source ?? "app");
    const store = drizzleOutboxStore();
    const { eventId, enqueued } = await enqueueLifecycleEvent(input, store);
    if (enqueued) {
      // Detached: the user's response does not wait on Resend or Meta.
      void processLifecycleOutbox({
        store,
        ids: [eventId],
        limit: 1,
        ...productionLegDeps(),
      }).catch((err: unknown) => {
        logger.info({ err, eventId }, "pe lifecycle: immediate send failed (outbox kept for the drain)");
      });
    }
    return eventId;
  } catch (err) {
    logger.info(
      { err, event: input.event },
      "pe lifecycle: enqueue failed (user action already committed)",
    );
    return null;
  }
}
