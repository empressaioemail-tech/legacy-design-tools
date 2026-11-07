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
import { ga4PurchaseInputFromOutboxRow, sendGa4Purchase } from "./peGa4Mp";
import {
  META_REFUSED_BY_NAME,
  metaCapiInputFromOutboxRow,
  sendMetaCapiEvent,
} from "./peMetaCapi";
import { sendLifecycleToResend } from "./peResendLifecycle";

type Db = typeof prodDb;

/**
 * GA4 purchase rides the ad-platform leg, sent ONCE (first attempt of the
 * Meta leg) so a Meta retry never duplicates it. Its outcome is logged and
 * never changes the Meta leg's state: GA is best-effort, Meta is the leg.
 */
async function ga4PurchaseOnce(row: OutboxRecord): Promise<void> {
  const input = ga4PurchaseInputFromOutboxRow(row);
  if (!input) return;
  if (row.legs.meta.attempts > 0) return;
  const r = await sendGa4Purchase(input);
  if (!r.ok) {
    logger.info({ eventId: row.id, error: r.error }, "pe lifecycle: GA4 purchase not sent");
  }
}

async function metaLeg(row: OutboxRecord, now: Date): Promise<MetaLegResult> {
  try {
    await ga4PurchaseOnce(row);
  } catch (err) {
    logger.info({ err, eventId: row.id }, "pe lifecycle: GA4 purchase threw (ignored)");
  }
  const m = await sendMetaCapiEvent(metaCapiInputFromOutboxRow(row, now));
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

/**
 * The detached tries still running. The user's response never waits on them;
 * a test harness does, before it truncates the tables they hold locks on
 * (CI 2026-10-03: a truncate under a live projection transaction deadlocked).
 */
const detached = new Set<Promise<unknown>>();

export async function settleDetachedLifecycleWork(): Promise<void> {
  while (detached.size > 0) await Promise.allSettled([...detached]);
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
      const work = processLifecycleOutbox({
        store,
        ids: [eventId],
        limit: 1,
        ...productionLegDeps(),
      })
        .catch((err: unknown) => {
          logger.info({ err, eventId }, "pe lifecycle: immediate send failed (outbox kept for the drain)");
        })
        .finally(() => detached.delete(work));
      detached.add(work);
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
