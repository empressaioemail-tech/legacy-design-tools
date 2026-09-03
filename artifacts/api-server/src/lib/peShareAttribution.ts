/**
 * P-100 item 3 — the share-attribution WRITER and the activation WRITER.
 *
 * The query half. The validators (`./peShareAttributionValidate`,
 * `./peAccountActivationValidate`) import no database and hold the closed
 * sets; this file only writes what they already accepted.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  peAccountActivations,
  peShareAttributions,
  peShareGrants,
  type PeAccountActivationMilestone,
} from "@workspace/db";

import {
  decideShareAttribution,
  type ShareAttributionDecision,
  type ShareGrantSnapshot,
} from "./peShareAttributionValidate";

export type ShareAttributionResult =
  | {
      ok: true;
      grantId: string;
      grantorUserId: string;
      attributedAt: string;
      /** false when the recipient was already attributed to an earlier grant. */
      firstTouch: boolean;
    }
  | { ok: false; refusal: Extract<ShareAttributionDecision, { action: "refuse" }>["reason"] };

/**
 * Attribute a recipient account to the sharer behind a grant.
 *
 * Neither id in the written row comes from the caller. The grant is read from
 * `pe_share_grants` by id; the recipient comes from the session the route
 * verified. The grantor is not stored at all — it is one join away and a
 * second copy could drift from the grant row.
 *
 * FIRST TOUCH IS ENFORCED TWICE, ON PURPOSE. The read below produces the
 * readable `already_attributed` refusal; `ON CONFLICT DO NOTHING` on the
 * recipient primary key is what actually holds under a race. If the two ever
 * disagree — the read said nothing existed and the insert wrote nothing — the
 * row that survives is the FIRST one, and it is read back and returned. The
 * caller is told `firstTouch: false` rather than being handed the grant it
 * asked for, because reporting the losing grant would credit the wrong
 * sharer.
 */
export async function attributeShareRecipient(input: {
  grantId: string;
  recipientUserId: string;
  surface: string | null;
}): Promise<ShareAttributionResult> {
  const [grantRow] = await db
    .select({
      id: peShareGrants.id,
      grantorUserId: peShareGrants.grantorUserId,
    })
    .from(peShareGrants)
    .where(eq(peShareGrants.id, input.grantId))
    .limit(1);

  const grant: ShareGrantSnapshot = grantRow
    ? { id: grantRow.id, grantorUserId: grantRow.grantorUserId }
    : null;

  const [existing] = await db
    .select({ grantId: peShareAttributions.grantId })
    .from(peShareAttributions)
    .where(eq(peShareAttributions.recipientUserId, input.recipientUserId))
    .limit(1);

  const decision = decideShareAttribution({
    grant,
    recipientUserId: input.recipientUserId,
    existingGrantId: existing?.grantId ?? null,
  });

  if (decision.action === "refuse") {
    if (decision.reason !== "already_attributed") {
      return { ok: false, refusal: decision.reason };
    }
    // Already attributed: report the ORIGINAL, never the grant just offered.
    const [row] = await db
      .select({
        grantId: peShareAttributions.grantId,
        attributedAt: peShareAttributions.attributedAt,
        grantorUserId: peShareGrants.grantorUserId,
      })
      .from(peShareAttributions)
      .innerJoin(peShareGrants, eq(peShareGrants.id, peShareAttributions.grantId))
      .where(eq(peShareAttributions.recipientUserId, input.recipientUserId))
      .limit(1);
    if (!row) {
      // The attribution exists but its grant does not. The FK makes this
      // unrepresentable; raising beats inventing a grantor.
      throw new Error("pe_share_attributions row has no resolvable grant");
    }
    return {
      ok: true,
      grantId: row.grantId,
      grantorUserId: row.grantorUserId,
      attributedAt: row.attributedAt.toISOString(),
      firstTouch: false,
    };
  }

  await db
    .insert(peShareAttributions)
    .values({
      recipientUserId: input.recipientUserId,
      grantId: decision.grantId,
      surface: input.surface,
    })
    .onConflictDoNothing();

  // Read back rather than echoing the input: the surviving row is the one
  // that counts, and its `attributed_at` is the database's clock, which is
  // the one every later ratio is bucketed by.
  const [written] = await db
    .select({
      grantId: peShareAttributions.grantId,
      attributedAt: peShareAttributions.attributedAt,
      grantorUserId: peShareGrants.grantorUserId,
    })
    .from(peShareAttributions)
    .innerJoin(peShareGrants, eq(peShareGrants.id, peShareAttributions.grantId))
    .where(eq(peShareAttributions.recipientUserId, input.recipientUserId))
    .limit(1);

  if (!written) {
    // An INSERT ... ON CONFLICT DO NOTHING followed by a read that finds
    // nothing means the write did not happen. Reporting success here would
    // be the fabricated-measurement defect this table exists to avoid.
    throw new Error("pe_share_attributions insert left no row");
  }

  return {
    ok: true,
    grantId: written.grantId,
    grantorUserId: written.grantorUserId,
    attributedAt: written.attributedAt.toISOString(),
    firstTouch: written.grantId === decision.grantId,
  };
}

// ---------------------------------------------------------------------------
// P-100 item 4 — the once-per-account activation writer
// ---------------------------------------------------------------------------

export type AccountActivationRecorded = {
  milestone: PeAccountActivationMilestone;
  surface: string | null;
  firstAt: string;
  /** false when this account had already reached the milestone. */
  firstTime: boolean;
};

/**
 * Record that an account reached a milestone for the first time.
 *
 * ONCE PER ACCOUNT IS THE COMPOSITE PRIMARY KEY, not a check in this
 * function. `ON CONFLICT DO NOTHING` plus a read-back means a re-fire cannot
 * write a second row, cannot move `first_at`, and cannot lose a race with a
 * concurrent first fire.
 *
 * `firstTime` is derived from whether the INSERT itself returned a row, never
 * from comparing timestamps. Two calls inside the same clock tick would
 * compare equal and both report first, and the whole value of this table is
 * that exactly one of them can.
 */
export async function recordAccountActivation(input: {
  ownerUserId: string;
  milestone: PeAccountActivationMilestone;
  surface: string | null;
}): Promise<AccountActivationRecorded> {
  const inserted = await db
    .insert(peAccountActivations)
    .values({
      ownerUserId: input.ownerUserId,
      milestone: input.milestone,
      surface: input.surface,
    })
    .onConflictDoNothing()
    .returning({ firstAt: peAccountActivations.firstAt });

  const firstTime = inserted.length > 0;

  const [row] = await db
    .select({
      milestone: peAccountActivations.milestone,
      surface: peAccountActivations.surface,
      firstAt: peAccountActivations.firstAt,
    })
    .from(peAccountActivations)
    .where(
      and(
        eq(peAccountActivations.ownerUserId, input.ownerUserId),
        eq(peAccountActivations.milestone, input.milestone),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error("pe_account_activations insert left no row");
  }

  return {
    milestone: row.milestone,
    surface: row.surface ?? null,
    firstAt: row.firstAt.toISOString(),
    firstTime,
  };
}
