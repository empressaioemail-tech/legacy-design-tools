/**
 * P-480 — Stripe webhook delivery ledger + entitlement history for PE billing.
 */

import { eq, sql } from "drizzle-orm";
import {
  db,
  peStripeWebhookEvents,
  peUserEntitlementHistory,
  peUserEntitlements,
  type PeBillingInterval,
  type PeSubscriptionTier,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

export type PeStripeWebhookRecord = {
  stripeEventId: string;
  eventType: string;
  checkoutSessionId?: string | null;
  amountTotalCents?: number | null;
  currency?: string | null;
  livemode: boolean;
  ownerUserId: string;
  outcome: string;
};

export type PeStripeEntitlementWrite = {
  userId: string;
  tier: "free" | "paid";
  subscriptionTier: PeSubscriptionTier | null;
  source: "stripe_sub" | "stripe_promo";
  stripeCustomerId?: string | null;
  seatsPurchased?: number | null;
  billingInterval?: PeBillingInterval | null;
};

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalizedEntitlementWrite(input: PeStripeEntitlementWrite) {
  const seatsPurchased =
    input.tier === "paid" && input.subscriptionTier === "team"
      ? (input.seatsPurchased ?? null)
      : null;
  return {
    accessTier: input.tier,
    subscriptionTier: input.tier === "paid" ? input.subscriptionTier : null,
    entitlementSource: input.tier === "paid" ? input.source : null,
    seatsPurchased,
    billingInterval:
      input.tier === "paid" ? (input.billingInterval ?? null) : null,
    stripeCustomerId: input.stripeCustomerId ?? undefined,
  };
}

function entitlementFieldsDiffer(
  current: typeof peUserEntitlements.$inferSelect,
  next: ReturnType<typeof normalizedEntitlementWrite>,
): boolean {
  const curCustomer = current.stripeCustomerId ?? null;
  const nextCustomer = next.stripeCustomerId ?? curCustomer;
  return (
    current.accessTier !== next.accessTier ||
    (current.subscriptionTier ?? null) !== (next.subscriptionTier ?? null) ||
    (current.entitlementSource ?? null) !==
      (next.entitlementSource ?? null) ||
    (current.seatsPurchased ?? null) !== (next.seatsPurchased ?? null) ||
    (current.billingInterval ?? null) !== (next.billingInterval ?? null) ||
    (next.stripeCustomerId !== undefined &&
      curCustomer !== (next.stripeCustomerId ?? null))
  );
}

async function insertWebhookEvent(
  tx: DbTx,
  record: PeStripeWebhookRecord,
): Promise<boolean> {
  const inserted = await tx
    .insert(peStripeWebhookEvents)
    .values({
      stripeEventId: record.stripeEventId,
      eventType: record.eventType,
      checkoutSessionId: record.checkoutSessionId ?? null,
      amountTotalCents: record.amountTotalCents ?? null,
      currency: record.currency ?? null,
      livemode: record.livemode,
      ownerUserId: record.ownerUserId,
      outcome: record.outcome,
    })
    .onConflictDoNothing()
    .returning({ stripeEventId: peStripeWebhookEvents.stripeEventId });
  return inserted.length > 0;
}

/**
 * Record a delivery outcome without touching entitlements. Returns whether
 * this invocation inserted the row (false = duplicate replay).
 */
export async function recordPeStripeWebhookOutcome(
  record: PeStripeWebhookRecord,
): Promise<"inserted" | "duplicate"> {
  return db.transaction(async (tx) => {
    const inserted = await insertWebhookEvent(tx, record);
    return inserted ? "inserted" : "duplicate";
  });
}

/**
 * Insert the webhook row, then apply the entitlement write. The webhook row
 * is inserted first; if that insert loses a race on stripe_event_id, the
 * entitlement write is skipped (idempotent replay).
 */
export async function commitPeStripeEntitlementChange(
  record: PeStripeWebhookRecord,
  entitlement: PeStripeEntitlementWrite,
): Promise<"applied" | "duplicate"> {
  return db.transaction(async (tx) => {
    const inserted = await insertWebhookEvent(tx, record);
    if (!inserted) {
      return "duplicate";
    }

    await tx
      .insert(peUserEntitlements)
      .values({
        ownerUserId: entitlement.userId,
        tenantId: DEFAULT_TENANT_ID,
        accessTier: "free",
      })
      .onConflictDoNothing();

    const [current] = await tx
      .select()
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, entitlement.userId))
      .for("update");

    const next = normalizedEntitlementWrite(entitlement);

    if (current && entitlementFieldsDiffer(current, next)) {
      await tx.insert(peUserEntitlementHistory).values({
        ownerUserId: current.ownerUserId,
        tenantId: current.tenantId,
        accessTier: current.accessTier,
        devRole: current.devRole,
        entitlementSource: current.entitlementSource,
        stripeCustomerId: current.stripeCustomerId,
        subscriptionTier: current.subscriptionTier,
        seatsPurchased: current.seatsPurchased,
        billingInterval: current.billingInterval,
        stripeEventId: record.stripeEventId,
      });
    }

    await tx
      .update(peUserEntitlements)
      .set({
        accessTier: next.accessTier,
        subscriptionTier: next.subscriptionTier,
        entitlementSource: next.entitlementSource,
        seatsPurchased: next.seatsPurchased,
        billingInterval: next.billingInterval,
        ...(next.stripeCustomerId !== undefined
          ? { stripeCustomerId: next.stripeCustomerId }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(peUserEntitlements.ownerUserId, entitlement.userId));

    return "applied";
  });
}

/** Read helper for tests and probes — newest history first. */
export async function listPeEntitlementHistoryForUser(ownerUserId: string) {
  return db
    .select()
    .from(peUserEntitlementHistory)
    .where(eq(peUserEntitlementHistory.ownerUserId, ownerUserId))
    .orderBy(sql`${peUserEntitlementHistory.supersededAt} DESC`);
}

export async function listPeStripeWebhookEventsForUser(ownerUserId: string) {
  return db
    .select()
    .from(peStripeWebhookEvents)
    .where(eq(peStripeWebhookEvents.ownerUserId, ownerUserId))
    .orderBy(sql`${peStripeWebhookEvents.receivedAt} ASC`);
}
