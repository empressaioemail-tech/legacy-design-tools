/**
 * E1 (`ss.account_created`) on a brand-new Property Explorer signup.
 *
 * Decision `_decisions/2026-10-03_ghl_retired_lifecycle_to_resend.md` (P-492).
 * Enqueues the event, then tries this row once, detached. A send failure
 * never fails sign-up; the outbox keeps the event and the scheduled drain
 * retries it.
 */

import { logger } from "./logger";
import { dispatchLifecycleEvent } from "./peLifecycleDispatch";
import { e1IdempotencyKey } from "./peLifecycleOutbox";
import { LIFECYCLE_EVENT_ID_FIELD } from "./peLifecycleTypes";

export { LIFECYCLE_EVENT_ID_FIELD };

export type NewPeSignupInput = {
  userId: string;
  email: string;
  displayName: string;
  campaign?: string;
};

export async function notifyLifecycleOfNewPeSignup(
  input: NewPeSignupInput,
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
        ...(input.campaign ? { campaign: input.campaign } : {}),
        plan: "free",
        billing: "none",
      },
    });
  } catch (err) {
    logger.info(
      { err },
      "pe sign-in: lifecycle E1 did not complete (fail-open, sign-up unaffected)",
    );
    return null;
  }
}
