/**
 * T1-A (2026-10-22) — in-app account deletion (App Review 5.1.1(v)).
 *
 * Order matters, and each step only runs if the one before it succeeded:
 *   1. Stripe: every live subscription on the user's customer is set to
 *      cancel AT PERIOD END (`cancel_at_period_end=true`) through the
 *      existing Stripe client (`stripePostForm`). If Stripe cannot be reached
 *      or is not configured while a customer exists, nothing is deleted: a
 *      deleted account that keeps billing is the worst outcome.
 *   2. Sessions: every token the user (and any account merged into them)
 *      holds is revoked, before any row is deleted, so a lingering token can
 *      never re-create a `users` row through the profile backfill.
 *   3. Data, in one transaction, per the existing data model: the `users`
 *      row is deleted, which CASCADEs every PE table keyed to it
 *      (identities, entitlements, saved properties, screens, unlocks,
 *      workbench state, activations, AI connections, share grants and
 *      attributions, lifecycle outbox, the ss_contact record, team rows,
 *      the merge log, and the T2-WATCH tables pe_watch_snapshots,
 *      pe_watch_changes and pe_push_subscriptions). Tables keyed by user id WITHOUT a foreign key are
 *      cleaned explicitly; records-request jobs keep their row (a purchase
 *      record) with the email anonymised; magic-link rows for the user's
 *      addresses are deleted. The Stripe customer itself is left in Stripe
 *      (financial record), detached from any user here.
 */

import { eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  peAccountMerges,
  peMagicLinkTokens,
  peUserIdentities,
  users,
} from "@workspace/db";
import { isStripeConfigured, stripePostForm } from "./brokerageStripe";
import { readPeStripeCustomerId } from "./pePaywallStripe";
import { listStripeSubscriptionsForCustomer } from "./peSubscriptionStripe";
import { revokeAllPeSessionsForUser } from "./peSessions";

/** Statuses that are still billing (same set the subscription route treats as live). */
const CANCELLABLE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

export type DeletePeAccountResult =
  | { ok: true; cancelledSubscriptionIds: string[] }
  | { ok: false; error: "stripe_not_configured" | "stripe_cancel_failed"; message: string };

/** Set every live subscription to cancel at period end. Returns the ids changed. */
export async function cancelPeSubscriptionsAtPeriodEnd(
  customerId: string,
): Promise<string[]> {
  const subs = await listStripeSubscriptionsForCustomer(customerId);
  const changed: string[] = [];
  for (const sub of subs) {
    const id = typeof sub.id === "string" ? sub.id : "";
    const status = typeof sub.status === "string" ? sub.status : "";
    if (!id || !CANCELLABLE_STATUSES.has(status)) continue;
    if (sub.cancel_at_period_end === true) continue;
    await stripePostForm(`/subscriptions/${encodeURIComponent(id)}`, {
      cancel_at_period_end: "true",
    });
    changed.push(id);
  }
  return changed;
}

/** User-keyed tables with NO foreign key to `users` (CASCADE does not reach them). */
const UNLINKED_OWNER_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "brokerage_user_profiles", column: "owner_user_id" },
  { table: "brokerage_install_claims", column: "owner_user_id" },
  { table: "canva_connections", column: "owner_user_id" },
  { table: "canva_oauth_states", column: "owner_user_id" },
  { table: "saved_workspace_spaces", column: "owner_user_id" },
  { table: "user_usage_metering", column: "owner_user_id" },
  { table: "architect_notification_reads", column: "user_id" },
];

export async function deletePeAccount(userId: string): Promise<DeletePeAccountResult> {
  // 1. Stripe first.
  const customerId = await readPeStripeCustomerId(userId);
  let cancelledSubscriptionIds: string[] = [];
  if (customerId) {
    if (!isStripeConfigured()) {
      return {
        ok: false,
        error: "stripe_not_configured",
        message: "Billing is not reachable right now, so the account was not deleted.",
      };
    }
    try {
      cancelledSubscriptionIds = await cancelPeSubscriptionsAtPeriodEnd(customerId);
    } catch (err) {
      return {
        ok: false,
        error: "stripe_cancel_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Accounts previously merged INTO this one go with it.
  const merged = await db
    .select({ id: peAccountMerges.mergedUserId })
    .from(peAccountMerges)
    .where(eq(peAccountMerges.survivorUserId, userId));
  const userIds = [userId, ...merged.map((m) => m.id)];

  // 2. Sessions.
  for (const id of userIds) {
    await revokeAllPeSessionsForUser(id, "account_deleted");
  }

  // 3. Data.
  const identityEmails = await db
    .select({ email: peUserIdentities.email })
    .from(peUserIdentities)
    .where(inArray(peUserIdentities.userId, userIds));
  const userEmails = await db
    .select({ email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
  const emails = [
    ...new Set(
      [...identityEmails, ...userEmails]
        .map((r) => r.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    ),
  ];

  await db.transaction(async (tx) => {
    if (emails.length > 0) {
      await tx.delete(peMagicLinkTokens).where(inArray(peMagicLinkTokens.email, emails));
    }
    await tx.execute(sql`
      UPDATE records_request_jobs SET user_email = NULL
       WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
    for (const { table, column } of UNLINKED_OWNER_TABLES) {
      await tx.execute(sql`
        DELETE FROM ${sql.identifier(table)}
         WHERE ${sql.identifier(column)} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    await tx
      .delete(users)
      .where(or(...userIds.map((id) => eq(users.id, id))));
  });

  return { ok: true, cancelledSubscriptionIds };
}
