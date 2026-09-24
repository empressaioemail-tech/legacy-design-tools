/**
 * GoHighLevel E1 (account created) on a brand-new Property Explorer signup.
 *
 * Decision `_decisions/2026-09-24_smart_site_lifecycle_pipeline_in_ghl.md`.
 * Enqueues the event, then tries to send in-request. A GHL/Meta failure
 * never fails sign-up; the outbox keeps the event for retry.
 */

import { logger } from "./logger";
import { dispatchLifecycleEvent } from "./peLifecycleDispatch";
import { e1IdempotencyKey } from "./peLifecycleOutbox";
import { LIFECYCLE_EVENT_ID_FIELD } from "./peLifecycleTypes";

export { LIFECYCLE_EVENT_ID_FIELD };

export type CreateGhlContactInput = {
  userId: string;
  email: string;
  displayName: string;
  campaign?: string;
};

export async function notifyGhlOfNewPeSignup(
  input: CreateGhlContactInput,
): Promise<string | null> {
  try {
    return await dispatchLifecycleEvent({
      userId: input.userId,
      email: input.email,
      event: "e1_account_created",
      idempotencyKey: e1IdempotencyKey(input.userId),
      apply: {
        email: input.email,
        displayName: input.displayName,
        event: "e1_account_created",
        campaign: input.campaign,
        plan: "free",
        billing: "none",
      },
    });
  } catch (err) {
    logger.info(
      { email: input.email, err },
      "pe session-exchange: GHL E1 did not complete (fail-open, sign-up unaffected)",
    );
    return null;
  }
}
