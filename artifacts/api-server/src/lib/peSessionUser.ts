/**
 * T1-A (2026-10-22) — the `user` object of the shared auth contract:
 * `{id, email, plan, planStatus, providers, createdAt}`.
 *
 * - `plan`: the paid ladder rung ("solo" | "studio" | "team"), "paid" for a
 *   paid row with no recorded rung (legacy pre-ladder), else "free".
 * - `planStatus`: "active" for a paid entitlement, "none" otherwise. This is
 *   the stored entitlement mirror, read without a live Stripe call (the
 *   session check runs on every app open); the live renewal / scheduled-
 *   cancellation facts stay on `GET /property-explorer/v1/subscription`.
 * - `providers`: the distinct sign-in providers holding an identity on this
 *   user, sorted (e.g. ["email","google"]).
 */

import { eq } from "drizzle-orm";
import { db, peUserIdentities, users } from "@workspace/db";
import { getPeEntitlementRow } from "./peIdentity";

export type PeSessionUser = {
  id: string;
  email: string | null;
  plan: string;
  planStatus: "active" | "none";
  providers: string[];
  createdAt: string;
};

export async function readPeSessionUser(
  userId: string,
): Promise<PeSessionUser | null> {
  const [user] = await db
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  const identities = await db
    .select({ provider: peUserIdentities.provider, email: peUserIdentities.email })
    .from(peUserIdentities)
    .where(eq(peUserIdentities.userId, userId));
  // No sign-in identity left (a deleted account whose `users` row the
  // profile backfill re-created, or a merged-away shell): not signed in.
  if (identities.length === 0) return null;
  const entitlement = await getPeEntitlementRow(userId);
  const paid = entitlement.accessTier === "paid";
  const providers = [...new Set(identities.map((i) => String(i.provider)))].sort();
  return {
    id: user.id,
    email: user.email ?? identities.find((i) => i.email)?.email ?? null,
    plan: paid ? (entitlement.subscriptionTier ?? "paid") : "free",
    planStatus: paid ? "active" : "none",
    providers,
    createdAt: user.createdAt.toISOString(),
  };
}
