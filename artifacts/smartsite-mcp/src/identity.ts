/**
 * AuthKit / OIDC subject → Smart Site user join (A-037).
 * Never creates a second account from the MCP path.
 */

import { and, eq } from "drizzle-orm";
import type { PeOidcProvider, PeSubscriptionTier } from "@workspace/db/schema";
import {
  db,
  peUserEntitlements,
  peUserIdentities,
  users,
} from "@workspace/db";

export type PeEntitlementRow = {
  accessTier: "free" | "paid";
  subscriptionTier: PeSubscriptionTier | null;
  devRole: boolean;
};

export type IdentityClaims = {
  provider?: PeOidcProvider;
  subject: string;
  email?: string | null;
};

function normalizeEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

async function getPeEntitlementRow(userId: string): Promise<PeEntitlementRow> {
  const [row] = await db
    .select({
      accessTier: peUserEntitlements.accessTier,
      subscriptionTier: peUserEntitlements.subscriptionTier,
      devRole: peUserEntitlements.devRole,
    })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, userId))
    .limit(1);
  return {
    accessTier: row?.accessTier === "paid" ? "paid" : "free",
    subscriptionTier: row?.subscriptionTier ?? null,
    devRole: row?.devRole === true,
  };
}

export async function resolveSmartsiteUserFromClaims(
  claims: IdentityClaims,
): Promise<
  | { ok: true; userId: string; entitlement: PeEntitlementRow }
  | { ok: false; reason: "no_identity_row" | "email_mismatch" }
> {
  const email = normalizeEmail(claims.email);

  if (claims.provider) {
    const [bySubject] = await db
      .select({ userId: peUserIdentities.userId, email: peUserIdentities.email })
      .from(peUserIdentities)
      .where(
        and(
          eq(peUserIdentities.provider, claims.provider),
          eq(peUserIdentities.subject, claims.subject),
        ),
      )
      .limit(1);

    if (bySubject) {
      if (email && bySubject.email && email !== bySubject.email) {
        return { ok: false, reason: "email_mismatch" };
      }
      const entitlement = await getPeEntitlementRow(bySubject.userId);
      return { ok: true, userId: bySubject.userId, entitlement };
    }

    if (email) {
      const [byEmail] = await db
        .select({ userId: peUserIdentities.userId })
        .from(peUserIdentities)
        .where(
          and(
            eq(peUserIdentities.provider, claims.provider),
            eq(peUserIdentities.email, email),
          ),
        )
        .limit(1);

      if (byEmail) {
        const entitlement = await getPeEntitlementRow(byEmail.userId);
        return { ok: true, userId: byEmail.userId, entitlement };
      }
    }
  }

  // WorkOS Standalone Connect: complete API user.id may appear as token sub.
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, claims.subject))
    .limit(1);
  if (userRow) {
    const entitlement = await getPeEntitlementRow(userRow.id);
    return { ok: true, userId: userRow.id, entitlement };
  }

  return { ok: false, reason: "no_identity_row" };
}
