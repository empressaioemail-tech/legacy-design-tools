/**
 * Per-parcel property-unlock lookup (P-119, OPS-16 A-103).
 *
 * Property Unlock is a DISTINCT entitlement path from a Studio/Team
 * subscription — a one-time/30-day, PARCEL-SCOPED unlock, not an
 * account-wide ladder rung (A-068). `entitlement.ts`'s
 * `SmartsiteEntitlementSnapshot` is deliberately account-wide only
 * (accessTier/subscriptionTier/devRole); it cannot answer "is THIS parcel
 * unlocked" and must not be made to by widening it into a broad
 * `tier !== 'paid'`-style check — that exact shape (api-server's old
 * `pe-site-plan-export-core.ts:430`) is the class of bug A-068 found live:
 * a Solo subscriber reading as entitled to Studio-only exports.
 *
 * Mirrors `hasPePropertyUnlock` in
 * artifacts/api-server/src/lib/peEntitlement.ts EXACTLY — same table, same
 * active-row predicate (`expires_at IS NULL OR expires_at > now`), same
 * per-parcel scoping. A fourth copy of this shape, matching the discipline
 * this codebase already accepts for `subscriptionTierGrantsStudio` (three
 * independent copies, one per surface — api-server, this package, and
 * hauska-map's client) rather than a shared import across repos.
 */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, pePropertyUnlocks } from "@workspace/db";

/**
 * True when an UNEXPIRED per-property unlock row exists for this user +
 * parcel. `expiresAt` null = unbounded (legacy/dev rows); a Stripe-sourced
 * unlock carries the 30-day bound and an expired row is treated as absent —
 * identical to the api-server predicate this ports.
 */
export async function hasPropertyUnlock(
  userId: string,
  parcelNodeId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ parcelNodeId: pePropertyUnlocks.parcelNodeId })
    .from(pePropertyUnlocks)
    .where(
      and(
        eq(pePropertyUnlocks.ownerUserId, userId),
        eq(pePropertyUnlocks.parcelNodeId, parcelNodeId),
        or(
          isNull(pePropertyUnlocks.expiresAt),
          gt(pePropertyUnlocks.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return row != null;
}
