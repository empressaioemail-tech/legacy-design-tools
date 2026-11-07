/**
 * Property Explorer OIDC identity upsert — called from session-exchange.
 */

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  peUserIdentities,
  peUserEntitlements,
  users,
  type PeBillingInterval,
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
  /**
   * T1-A: is `email` PROVEN for this identity? Google: the ID token's
   * `email_verified` claim, forwarded by the BFF. Email provider: always
   * (a redeemed code or link proves it; forced true below). Microsoft:
   * never (forced false below; the app no longer offers it). Absent means
   * unverified, and an unverified email never links to an existing account.
   */
  emailVerified?: boolean;
};

export type PeIdentityResult = {
  userId: string;
  email: string | null;
  displayName: string;
  isNewUser: boolean;
  /** T1-A: true when this sign-in attached a NEW provider identity to an existing user by verified email. */
  linkedByVerifiedEmail?: boolean;
};

/**
 * T1-A: is the email on this identity proven? The provider decides, not the
 * caller: an email-code/link identity is proven by construction, Microsoft
 * is never trusted for linking, Google (and a future Apple) only when the
 * BFF forwarded the IdP's own verified claim.
 */
export function peIdentityEmailVerified(input: PeIdentityInput): boolean {
  if (!normalizeEmail(input.email)) return false;
  if (input.provider === "email") return true;
  if (input.provider === "microsoft") return false;
  return input.emailVerified === true;
}

/**
 * T1-A: the existing user a verified email links to, or null. Only users
 * holding an identity whose email is ALSO verified are candidates, so an
 * account created through an unverified address can never be joined by
 * proving that address later. When several users qualify (duplicates the
 * one-time merge has not folded yet), the same rule the merge uses picks
 * one: paid plan first, then the most recent paid period, then the oldest
 * account.
 */
export async function findPeUserByVerifiedEmail(
  email: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT u.id AS user_id
      FROM users u
      LEFT JOIN pe_user_entitlements e ON e.owner_user_id = u.id
     WHERE u.id IN (
             SELECT i.user_id FROM pe_user_identities i
              WHERE i.email_verified AND lower(i.email) = ${email}
           )
     ORDER BY (e.access_tier = 'paid') DESC NULLS LAST,
              CASE WHEN e.access_tier = 'paid' THEN COALESCE(
                (SELECT max(w.received_at) FROM pe_stripe_webhook_events w
                  WHERE w.owner_user_id = u.id),
                e.updated_at) END DESC NULLS LAST,
              u.created_at ASC,
              u.id ASC
     LIMIT 1`);
  const rows = (result as unknown as { rows: { user_id: string }[] }).rows;
  return rows[0]?.user_id ?? null;
}

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
  const emailVerified = peIdentityEmailVerified(input);
  const existing = await db
    .select({
      userId: peUserIdentities.userId,
      email: peUserIdentities.email,
      emailVerified: peUserIdentities.emailVerified,
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
    if (email && (email !== existing[0].email || emailVerified !== existing[0].emailVerified)) {
      // The verified flag always describes the email currently stored: a
      // changed address starts unverified unless this sign-in proves it.
      await db
        .update(peUserIdentities)
        .set({ email, emailVerified, updatedAt: new Date() })
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

  // T1-A (ruling 3): a NEW provider identity whose verified email matches an
  // existing user's verified email attaches to that user instead of
  // creating a second account. Unverified emails never link.
  if (email && emailVerified) {
    const linkedUserId = await findPeUserByVerifiedEmail(email);
    if (linkedUserId) {
      const inserted = await db
        .insert(peUserIdentities)
        .values({
          id: identityRowId(input.provider, input.subject),
          userId: linkedUserId,
          provider: input.provider,
          subject: input.subject,
          email,
          emailVerified: true,
        })
        .onConflictDoNothing()
        .returning({ userId: peUserIdentities.userId });
      if (inserted.length === 0) {
        // A concurrent sign-in with the same (provider, subject) won the
        // insert; answer as the returning-identity path would.
        return upsertPeOidcIdentity(input);
      }
      const [userRow] = await db
        .select({ displayName: users.displayName, email: users.email })
        .from(users)
        .where(eq(users.id, linkedUserId))
        .limit(1);
      await ensurePeEntitlement(linkedUserId);
      return {
        userId: linkedUserId,
        email: userRow?.email ?? email,
        displayName: userRow?.displayName ?? linkedUserId,
        isNewUser: false,
        linkedByVerifiedEmail: true,
      };
    }
  }

  const userId = newUserId();
  const displayName =
    input.displayName?.trim() ||
    (email ? email.split("@")[0]! : `User ${randomBytes(3).toString("hex")}`);

  // Pre-existing defect, found and fixed while building P-112 (email magic
  // link): `ensureUserProfile` below inserts a bare `users` row (no email)
  // as a profile-hydration side effect. The insert that FOLLOWS it — meant
  // to be the authoritative write of this brand-new identity's email — used
  // `onConflictDoNothing()`, so it silently no-op'd against the row
  // `ensureUserProfile` had just created one line above, and `users.email`
  // was left null for EVERY newly created PE user regardless of provider.
  // `pe_user_identities.email` (written a few lines down) was never
  // affected, and callers that read `identity.email` off this function's
  // own return value (session-exchange, the GHL hook, this file's own
  // in-memory `email` variable) were never affected either — only anything
  // reading `users.email` back from the DB was. That is very likely the
  // root cause behind hauska-map's "blank Stripe checkout email" bug
  // (worked around downstream today rather than traced to source).
  // `onConflictDoUpdate` makes this insert authoritative for a brand-new
  // identity's displayName/email regardless of insert order.
  await ensureUserProfile(userId, displayName);
  await db
    .insert(users)
    .values({ id: userId, displayName, email })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName, email },
    });

  await db.insert(peUserIdentities).values({
    id: identityRowId(input.provider, input.subject),
    userId,
    provider: input.provider,
    subject: input.subject,
    email,
    emailVerified,
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
  /**
   * Checkout seat count on a Team subscription; null = unknown or not Team.
   * Read here (P-98) so the account-scoped `/entitlement` answer does not
   * need a second query for it.
   */
  seatsPurchased: number | null;
  /**
   * Billing interval of the subscription (P-98, migration 0092). Null means
   * UNKNOWN, which is what every row written before 0092 carries, because
   * nothing backfills it. A reader must not treat null as monthly.
   */
  billingInterval: PeBillingInterval | null;
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
      seatsPurchased: peUserEntitlements.seatsPurchased,
      billingInterval: peUserEntitlements.billingInterval,
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
    // No row at all, a NULL column, and a stored value are collapsed to the
    // same two states on purpose: present, or unknown. Neither is defaulted.
    seatsPurchased: row?.seatsPurchased ?? null,
    billingInterval: row?.billingInterval ?? null,
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

/**
 * Look up a PE user's email for Stripe checkout. Stripe Custom/Elements
 * Checkout requires an email on the session before `confirm()` will
 * succeed — `getOrCreatePeStripeCustomer` already accepts one, but no
 * checkout route was populating it, so a fresh Stripe customer had no
 * email and every confirm attempt failed with "An email address is
 * required to confirm this Checkout Session."
 */
export async function getPeUserEmail(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
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
  /**
   * Billing interval derived from the billed price ids (P-98). Null means
   * UNKNOWN — an unmatched price id, an unreadable subscription, or a
   * pre-0092 row. Never omit the column on update, for the same reason the
   * seat count is never omitted: a leftover "month" after a switch to
   * annual is a silent false claim about the customer's billing, and it is
   * the one input that would make the `annual_upgrade` rung upsell an
   * annual subscriber.
   */
  billingInterval?: PeBillingInterval | null;
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
      // Cleared on churn: a free row has no subscription, so it has no
      // interval. Only a paid grant can carry one.
      billingInterval:
        input.tier === "paid" ? (input.billingInterval ?? null) : null,
      ...(input.stripeCustomerId
        ? { stripeCustomerId: input.stripeCustomerId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(peUserEntitlements.ownerUserId, input.userId));
}
