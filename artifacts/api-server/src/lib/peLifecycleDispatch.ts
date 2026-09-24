/**
 * Production entry: enqueue a lifecycle event and try to send it now.
 * The user path never awaits a GHL/Meta success. Process failures stay
 * on the outbox for retry.
 */

import { logger } from "./logger";
import { drizzleOutboxStore } from "./peLifecycleOutbox.drizzle";
import {
  assertPaidEventFromWebhook,
  enqueueLifecycleEvent,
  processLifecycleOutbox,
  type EnqueueInput,
} from "./peLifecycleOutbox";
import type { LifecycleEventType } from "./peLifecycleTypes";

export async function dispatchLifecycleEvent(
  input: EnqueueInput & { source?: string },
): Promise<string | null> {
  try {
    assertPaidEventFromWebhook(input.event, input.source ?? "app");
    const store = drizzleOutboxStore();
    const { eventId } = await enqueueLifecycleEvent(input, store);
    try {
      await processLifecycleOutbox({ store });
    } catch (err) {
      logger.info({ err, eventId }, "pe lifecycle: immediate send failed (outbox kept)");
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

export function paidEventTypeForStripe(kind: "unlock" | "plan"): LifecycleEventType {
  return kind === "unlock" ? "e4_unlock_bought" : "e5_plan_started";
}
