/**
 * Route-level hooks: count, enqueue, return event id. Never throw to
 * the caller — the user's action already committed.
 */

import { count, eq } from "drizzle-orm";
import { db, peSavedProperties, peShareGrants } from "@workspace/db";
import { logger } from "./logger";
import { dispatchLifecycleEvent } from "./peLifecycleDispatch";
import {
  e2IdempotencyKey,
  e3IdempotencyKey,
  e4IdempotencyKey,
  e5IdempotencyKey,
  planCancelledIdempotencyKey,
  planEndedUnpaidIdempotencyKey,
  paymentFailedIdempotencyKey,
} from "./peLifecycleOutbox";
import { getPeUserEmail } from "./peIdentity";
import type { LifecycleEventType, SsBilling, SsPlan } from "./peLifecycleTypes";

/**
 * @deprecated Prefer explicit lifecycle event types from the Stripe webhook;
 * kept for unlock checkout and tests.
 */
export function paidEventTypeForStripe(
  kind: "unlock" | "plan",
  plan: SsPlan,
): LifecycleEventType {
  if (kind === "unlock") return "e4_unlock_bought";
  return plan === "free" ? "plan_cancelled" : "e5_plan_started";
}

export async function countSavedLots(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(peSavedProperties)
    .where(eq(peSavedProperties.ownerUserId, userId));
  return Number(row?.n ?? 0);
}

export async function countSharesSent(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(peShareGrants)
    .where(eq(peShareGrants.grantorUserId, userId));
  return Number(row?.n ?? 0);
}

export async function emitLotSaved(userId: string): Promise<string | null> {
  try {
    const email = await getPeUserEmail(userId);
    if (!email) return null;
    const savedLots = await countSavedLots(userId);
    return await dispatchLifecycleEvent({
      userId,
      email,
      event: "e2_lot_saved",
      idempotencyKey: e2IdempotencyKey(userId, savedLots),
      apply: { email, event: "e2_lot_saved", savedLots },
    });
  } catch (err) {
    logger.info({ err, userId }, "pe lifecycle: E2 emit failed (fail-open)");
    return null;
  }
}

export async function emitShareSent(
  userId: string,
  shareGrantId: string,
): Promise<string | null> {
  try {
    const email = await getPeUserEmail(userId);
    if (!email) return null;
    const shares = await countSharesSent(userId);
    return await dispatchLifecycleEvent({
      userId,
      email,
      event: "e3_share_sent",
      idempotencyKey: e3IdempotencyKey(shareGrantId),
      apply: { email, event: "e3_share_sent", shares },
    });
  } catch (err) {
    logger.info({ err, userId }, "pe lifecycle: E3 emit failed (fail-open)");
    return null;
  }
}

export async function emitLifecycleFromStripeWebhook(input: {
  userId: string;
  event: LifecycleEventType;
  idempotencyKey: string;
  plan?: SsPlan;
  billing?: SsBilling;
  value?: number;
  currency?: string;
}): Promise<string | null> {
  try {
    const email = await getPeUserEmail(input.userId);
    if (!email) return null;
    return await dispatchLifecycleEvent({
      userId: input.userId,
      email,
      event: input.event,
      idempotencyKey: input.idempotencyKey,
      source: "stripe_webhook",
      apply: {
        email,
        event: input.event,
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        ...(input.billing !== undefined ? { billing: input.billing } : {}),
        value: input.value,
        currency: input.currency ?? "USD",
      },
    });
  } catch (err) {
    logger.info(
      { err, userId: input.userId, event: input.event },
      "pe lifecycle: stripe emit failed (fail-open)",
    );
    return null;
  }
}

export async function emitPaidFromStripeWebhook(input: {
  userId: string;
  stripeEventId: string;
  kind: "unlock" | "plan";
  plan: SsPlan;
  billing: SsBilling;
  value?: number;
  currency?: string;
  /** When set, used instead of deriving from kind/plan (P-494). */
  lifecycleEvent?: LifecycleEventType;
  idempotencyKey?: string;
}): Promise<string | null> {
  const event =
    input.lifecycleEvent ?? paidEventTypeForStripe(input.kind, input.plan);
  const idempotencyKey =
    input.idempotencyKey ??
    (event === "e4_unlock_bought"
      ? e4IdempotencyKey(input.stripeEventId)
      : event === "plan_cancelled"
        ? planCancelledIdempotencyKey(input.stripeEventId)
        : event === "plan_ended_unpaid"
          ? planEndedUnpaidIdempotencyKey(input.stripeEventId)
          : event === "payment_failed"
            ? paymentFailedIdempotencyKey(input.stripeEventId)
            : e5IdempotencyKey(input.stripeEventId));
  return emitLifecycleFromStripeWebhook({
    userId: input.userId,
    event,
    idempotencyKey,
    plan: input.plan,
    billing: input.billing,
    value: input.value,
    currency: input.currency,
  });
}
