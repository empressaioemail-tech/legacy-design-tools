/**
 * P-98 — the account-wide ACTIVE unlock read, with expiry.
 *
 * `hasPePropertyUnlock` in ./peEntitlement answers "is THIS parcel unlocked",
 * one parcel at a time. Nothing could answer "what has this account unlocked,
 * and when does each lapse", which is the fact the next-action rail's
 * highest-intent rung needs ("your unlock on 1102 Pine lapses in four days").
 *
 * EXPIRY IS STORED, NOT DERIVED. `pe_property_unlocks.expires_at` is a real
 * nullable column. `PE_PROPERTY_UNLOCK_DURATION_DAYS` (pePaywallStripe.ts) is
 * a WRITE-side constant: the Stripe webhook computes `now + 30 days` and
 * hands it to `createPePropertyUnlock`. No read derives an expiry from it and
 * this one does not either. A row with `expires_at` NULL is a legacy or
 * operator dev unlock that is UNBOUNDED; it ships as `expiresAt: null`.
 * Synthesising `unlocked_at + 30 days` for those rows would invent a lapse
 * date, and the rail would then tell someone an unlimited unlock is expiring.
 *
 * ONE DEFINITION OF ACTIVE. The predicate below is the same one
 * `hasPePropertyUnlock` uses -- `expires_at IS NULL OR expires_at > :asOf`.
 * Two derivations of "active" would eventually disagree, and the per-parcel
 * gate and this list would then contradict each other on the same row.
 *
 * WHY `asOf` SHIPS. The list is a snapshot against one instant, and a
 * consumer computing "lapses in four days" must use the instant the filter
 * used or its arithmetic disagrees with the set it is describing. Returning
 * the clock means the client needs no clock of its own and no rounding rule
 * has to be invented here.
 *
 * NOT FILTERED BY TENANT. `pe_property_unlocks` is keyed on
 * (owner_user_id, tenant_id, parcel_node_id), but the question is
 * account-wide. Narrowing to the session tenant would silently hide unlocks
 * bought under another one and read as "you have no unlocks". The tenant is
 * RETURNED per row so a consumer can see it; it never narrows the set.
 */

import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { db, pePropertyUnlocks } from "@workspace/db";

export type PeUnlockView = {
  parcelNodeId: string;
  tenantId: string;
  /** ISO. When the unlock was granted or last renewed. */
  unlockedAt: string;
  /** ISO, or `null` for an UNBOUNDED unlock. Never synthesised. */
  expiresAt: string | null;
  /** What wrote it: `stripe`, `dev`, `stub`. */
  source: string;
};

export type PeUnlocksRead = {
  /** The instant the ACTIVE predicate was evaluated at. ISO. */
  asOf: string;
  /** Soonest-lapsing first; unbounded unlocks last. */
  unlocks: PeUnlockView[];
};

export async function readActiveUnlocks(
  ownerUserId: string,
  asOf: Date = new Date(),
): Promise<PeUnlocksRead> {
  const rows = await db
    .select({
      parcelNodeId: pePropertyUnlocks.parcelNodeId,
      tenantId: pePropertyUnlocks.tenantId,
      unlockedAt: pePropertyUnlocks.unlockedAt,
      expiresAt: pePropertyUnlocks.expiresAt,
      source: pePropertyUnlocks.source,
    })
    .from(pePropertyUnlocks)
    .where(
      and(
        eq(pePropertyUnlocks.ownerUserId, ownerUserId),
        // Identical to hasPePropertyUnlock. Do not restate it differently.
        or(
          isNull(pePropertyUnlocks.expiresAt),
          gt(pePropertyUnlocks.expiresAt, asOf),
        ),
      ),
    )
    // Postgres sorts NULLS LAST on ASC by default, which is what is wanted:
    // an unbounded unlock is the least urgent thing in the list, not the
    // most. parcel_node_id is a stable tiebreak so the order is total.
    .orderBy(asc(pePropertyUnlocks.expiresAt), asc(pePropertyUnlocks.parcelNodeId));

  return {
    asOf: asOf.toISOString(),
    unlocks: rows.map((r) => ({
      parcelNodeId: r.parcelNodeId,
      tenantId: r.tenantId,
      unlockedAt: r.unlockedAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      source: r.source,
    })),
  };
}
