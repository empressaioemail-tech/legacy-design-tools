/**
 * Route-level hooks: count, enqueue, return event id. Never throw to
 * the caller — the user's action already committed.
 */

import { count, eq } from "drizzle-orm";
import { db, peSavedProperties, peShareGrants } from "@workspace/db";
import { logger } from "./logger";
import { dispatchLifecycleEvent, paidEventTypeForStripe } from "./peLifecycleDispatch";
import {
  e2IdempotencyKey,
  e3IdempotencyKey,
  e4IdempotencyKey,
  e5IdempotencyKey,
} from "./peLifecycleOutbox";
import { getPeUserEmail } from "./peIdentity";
import type { SsBilling, SsPlan } from "./peLifecycleTypes";

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

export async function emitPaidFromStripeWebhook(input: {
  userId: string;
  stripeEventId: string;
  kind: "unlock" | "plan";
  plan: SsPlan;
  billing: SsBilling;
  value?: number;
  currency?: string;
}): Promise<string | null> {
  try {
    const email = await getPeUserEmail(input.userId);
    if (!email) return null;
    const event = paidEventTypeForStripe(input.kind);
    const idempotencyKey =
      input.kind === "unlock"
        ? e4IdempotencyKey(input.stripeEventId)
        : e5IdempotencyKey(input.stripeEventId);
    return await dispatchLifecycleEvent({
      userId: input.userId,
      email,
      event,
      idempotencyKey,
      source: "stripe_webhook",
      apply: {
        email,
        event,
        plan: input.plan,
        billing: input.billing,
        value: input.value,
        currency: input.currency ?? "USD",
      },
    });
  } catch (err) {
    logger.info({ err, userId: input.userId }, "pe lifecycle: paid emit failed (fail-open)");
    return null;
  }
}
