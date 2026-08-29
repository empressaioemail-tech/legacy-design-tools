/**
 * Property Explorer OIDC identity upsert — called from session-exchange.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  peUserIdentities,
  peUserEntitlements,
  users,
  type PeOidcProvider,
  type PeSubscriptionTier,
} from "@workspace/db";
import { ensureUserProfile } from "./userProfiles";
import { newUserId } from "./sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

export type PeIdentityInput = {
  provider: PeOidcProvider;
  subject: string;
  email?: string;
  displayName?: string;
};

export type PeIdentityResult = {
  userId: string;
  email: string | null;
  displayName: string;
  isNewUser: boolean;
};

function normalizeEmail(email: string | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

function identityRowId(provider: string, subject: string): string {
  return `pei_${provider}_${subject.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)}`;
}

export async function upsertPeOidcIdentity(
  input: PeIdentityInput,
): Promise<PeIdentityResult> {
  const email = normalizeEmail(input.email);
  const existing = await db
    .select({
      userId: peUserIdentities.userId,
      email: peUserIdentities.email,
    })
    .from(peUserIdentities)
    .where(
      and(
        eq(peUserIdentities.provider, input.provider),
        eq(peUserIdentities.subject, input.subject),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const [userRow] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, existing[0].userId))
      .limit(1);
    if (email && email !== existing[0].email) {
      await db
        .update(peUserIdentities)
        .set({ email, updatedAt: new Date() })
        .where(
          and(
            eq(peUserIdentities.provider, input.provider),
            eq(peUserIdentities.subject, input.subject),
          ),
        );
    }
    await ensurePeEntitlement(existing[0].userId);
    return {
      userId: existing[0].userId,
      email: email ?? existing[0].email,
      displayName: userRow?.displayName ?? existing[0].userId,
      isNewUser: false,
    };
  }

  const userId = newUserId();
  const displayName =
    input.displayName?.trim() ||
    (email ? email.split("@")[0]! : `User ${randomBytes(3).toString("hex")}`);

  await ensureUserProfile(userId, displayName);
  await db
    .insert(users)
    .values({ id: userId, displayName, email })
    .onConflictDoNothing();

  await db.insert(peUserIdentities).values({
    id: identityRowId(input.provider, input.subject),
    userId,
    provider: input.provider,
    subject: input.subject,
    email,
  });

  await ensurePeEntitlement(userId);

  return { userId, email, displayName, isNewUser: true };
}

export async function ensurePeEntitlement(userId: string): Promise<void> {
  await db
    .insert(peUserEntitlements)
    .values({
      ownerUserId: userId,
      tenantId: DEFAULT_TENANT_ID,
      accessTier: "free",
    })
    .onConflictDoNothing();
}

export async function getPeAccessTier(
  userId: string,
): Promise<"free" | "paid"> {
  const [row] = await db
    .select({ accessTier: peUserEntitlements.accessTier })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, userId))
    .limit(1);
  return row?.accessTier === "paid" ? "paid" : "free";
}

export type PeEntitlementRow = {
  accessTier: "free" | "paid";
  /** Ladder rung for paid subscribers (LOCKED 2026-08-10); null = free / unlock-only / legacy pre-ladder. */
  subscriptionTier: PeSubscriptionTier | null;
  devRole: boolean;
  entitlementSource: "stripe_sub" | "stripe_promo" | "stripe_unlock" | "dev" | null;
  stripeCustomerId: string | null;
};

/** Full entitlement row read (WDLL 2026-08-05 item 1/4) — dev role + provenance. */
export async function getPeEntitlementRow(
  userId: string,
): Promise<PeEntitlementRow> {
  const [row] = await db
    .select({
      accessTier: peUserEntitlements.accessTier,
      subscriptionTier: peUserEntitlements.subscriptionTier,
      devRole: peUserEntitlements.devRole,
      entitlementSource: peUserEntitlements.entitlementSource,
      stripeCustomerId: peUserEntitlements.stripeCustomerId,
    })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, userId))
    .limit(1);
  return {
    accessTier: row?.accessTier === "paid" ? "paid" : "free",
    subscriptionTier: row?.subscriptionTier ?? null,
    devRole: row?.devRole === true,
    entitlementSource: row?.entitlementSource ?? null,
    stripeCustomerId: row?.stripeCustomerId ?? null,
  };
}

/** Set (or clear) the operator dev role for a user (WDLL item 4). */
export async function setPeDevRole(
  userId: string,
  devRole: boolean,
): Promise<void> {
  await ensurePeEntitlement(userId);
  await db
    .update(peUserEntitlements)
    .set({ devRole, updatedAt: new Date() })
    .where(eq(peUserEntitlements.ownerUserId, userId));
}

/** Link a Stripe customer id to a PE user's entitlement row. */
export async function setPeStripeCustomerId(
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  await ensurePeEntitlement(userId);
  await db
    .update(peUserEntitlements)
    .set({ stripeCustomerId, updatedAt: new Date() })
    .where(eq(peUserEntitlements.ownerUserId, userId));
}

/**
 * Resolve an existing PE user's owner id from a Stripe customer id, e.g. to
 * find the target of a `customer.subscription.*` webhook that carries no
 * `metadata.pe_user_id` on the subscription object itself.
 */
export async function findPeUserIdByStripeCustomerId(
  stripeCustomerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ownerUserId: peUserEntitlements.ownerUserId })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row?.ownerUserId ?? null;
}

/**
 * Set a PE user's paid entitlement + provenance in one write (WDLL 2026-08-05
 * item 2/5 — Stripe checkout/webhook is the sole writer of `access_tier` for
 * subscription and promo paths).
 */
export async function setPeAccessTierFromStripe(input: {
  userId: string;
  tier: "free" | "paid";
  /**
   * Ladder rung (LOCKED 2026-08-10) for `tier: "paid"`. Required on paid
   * writes so a Solo payment can never silently read as Studio; cleared on
   * `tier: "free"` (churn).
   */
  subscriptionTier: PeSubscriptionTier | null;
  source: "stripe_sub" | "stripe_promo";
  stripeCustomerId?: string | null;
  /**
   * Team seat count from billed Stripe items. Null on solo/studio, churn,
   * or a Team grant whose items were not readable. Never omit the column
   * on update — a leftover number after downgrade is a silent seat grant.
   */
  seatsPurchased?: number | null;
}): Promise<void> {
  await ensurePeEntitlement(input.userId);
  const seatsPurchased =
    input.tier === "paid" && input.subscriptionTier === "team"
      ? (input.seatsPurchased ?? null)
      : null;
  await db
    .update(peUserEntitlements)
    .set({
      accessTier: input.tier,
      subscriptionTier: input.tier === "paid" ? input.subscriptionTier : null,
      entitlementSource: input.tier === "paid" ? input.source : null,
      seatsPurchased,
      ...(input.stripeCustomerId
        ? { stripeCustomerId: input.stripeCustomerId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(peUserEntitlements.ownerUserId, input.userId));
}
