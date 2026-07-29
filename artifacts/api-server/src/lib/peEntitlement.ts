/**
 * Property Explorer entitlement resolution and deep-route gate helpers.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  peUserIdentities,
  pePropertyUnlocks,
  peChatMessageCounts,
} from "@workspace/db";
import { getPeAccessTier } from "./peIdentity";
import { isAnonymousOwnerId } from "./anonymousOwnerCookie";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

/** Signed-in-free chat allowance per property (LOCK ruling 2026-07-29). */
export const PE_FREE_CHAT_MESSAGE_LIMIT = 3;

export type PeEntitlementSnapshot = {
  tier: "free" | "paid";
  tenantId: string;
  userId: string | null;
  authenticated: boolean;
};

export function resolvePeOwnerUserId(req: Request): string | null {
  const userId = req.session.requestor?.kind === "user"
    ? req.session.requestor.id
    : undefined;
  // `pr_anon_owner` gives browse-only sessions an isolated owner for legacy
  // workspace writes. It is not an authenticated Property Explorer account:
  // treating it as one would turn anonymous deep requests into free-tier 402s.
  if (userId && !isAnonymousOwnerId(userId)) {
    return userId;
  }
  return null;
}

export async function resolvePeEntitlement(
  req: Request,
): Promise<PeEntitlementSnapshot> {
  const userId = resolvePeOwnerUserId(req);
  if (!userId) {
    return {
      tier: "free",
      tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
      userId: null,
      authenticated: false,
    };
  }
  const tier = await getPeAccessTier(userId);
  return {
    tier,
    tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
    userId,
    authenticated: true,
  };
}

/** Requires a verified user session (not anonymous, not service caller). */
export const requirePeAuthenticated: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = resolvePeOwnerUserId(req);
  if (!userId) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  next();
};

/** Requires paid tier for deep report routes (R1–R10). Free tier gets 402. */
export const requirePePaidDeep: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = resolvePeOwnerUserId(req);
  if (!userId) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  const tier = await getPeAccessTier(userId);
  if (await hasPeDevPaidBypass(userId)) {
    next();
    return;
  }
  if (tier !== "paid") {
    res.status(402).json({
      error: "upgrade_required",
      message: "Paid deep access required for this route",
      tier,
    });
    return;
  }
  next();
};

/** True when a per-property unlock row exists for this user + parcel. */
export async function hasPePropertyUnlock(
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
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * R1 property-scoped entitlement check (LOCK 2026-07-29):
 * paid tier OR a pe_property_unlocks row for this parcel OR the operator
 * dev bypass. `parcelNodeId` null degrades to the user-level check only
 * (paid / bypass) — never an implicit property unlock.
 */
export async function isPePropertyEntitled(
  userId: string,
  parcelNodeId: string | null,
): Promise<boolean> {
  const tier = await getPeAccessTier(userId);
  if (tier === "paid") return true;
  if (await hasPeDevPaidBypass(userId)) return true;
  if (!parcelNodeId) return false;
  return hasPePropertyUnlock(userId, parcelNodeId);
}

/**
 * Stub unlock WRITER (interface, not payments). Everything that grants a
 * per-property unlock funnels through here: today the operator dev-unlock
 * route (`source: "dev"`), later the Stripe one-time checkout webhook calls
 * this same function with `source: "stripe"` — no live charging in this
 * wave (auth-orphan lesson: the payment flip ships isolated).
 */
export async function createPePropertyUnlock(input: {
  ownerUserId: string;
  parcelNodeId: string;
  tenantId?: string;
  source?: string;
}): Promise<void> {
  await db
    .insert(pePropertyUnlocks)
    .values({
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      parcelNodeId: input.parcelNodeId,
      source: input.source ?? "stub",
    })
    .onConflictDoNothing();
}

/** Free chat messages already consumed on this property by this user. */
export async function getPeFreeChatMessagesUsed(
  userId: string,
  parcelNodeId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: peChatMessageCounts.count })
    .from(peChatMessageCounts)
    .where(
      and(
        eq(peChatMessageCounts.ownerUserId, userId),
        eq(peChatMessageCounts.parcelNodeId, parcelNodeId),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Atomically consume one free chat message for (user, parcel).
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING`
 * (permit_counters precedent): concurrent messages serialize on the row
 * lock; when the guarded update matches no row the allowance is exhausted
 * and nothing is incremented. Never called for entitled users.
 */
export async function consumePeFreeChatMessage(
  userId: string,
  parcelNodeId: string,
): Promise<{ allowed: boolean; used: number }> {
  const rows = await db
    .insert(peChatMessageCounts)
    .values({
      ownerUserId: userId,
      parcelNodeId,
      count: 1,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [peChatMessageCounts.ownerUserId, peChatMessageCounts.parcelNodeId],
      set: {
        count: sql`${peChatMessageCounts.count} + 1`,
        updatedAt: new Date(),
      },
      setWhere: sql`${peChatMessageCounts.count} < ${PE_FREE_CHAT_MESSAGE_LIMIT}`,
    })
    .returning({ count: peChatMessageCounts.count });
  if (rows.length === 0) {
    return { allowed: false, used: await getPeFreeChatMessagesUsed(userId, parcelNodeId) };
  }
  return { allowed: true, used: rows[0]!.count };
}

/**
 * Per-property paid gate (replaces {@link requirePePaidDeep} on the
 * per-property-unlockable report routes): paid tier OR dev bypass OR a
 * property unlock for the parcel resolved from the request. When no
 * parcelNodeId is resolvable the gate degrades to paid-only — identical to
 * the old behavior, never a silent open. Terrain is NOT gated here: terrain
 * stays Pro-only, enforced PE-BFF-side off the `/entitlement` `tier` field.
 */
export function requirePePaidOrPropertyUnlocked(
  resolveParcelNodeId?: (req: Request) => string | null,
): RequestHandler {
  const resolve =
    resolveParcelNodeId ??
    ((req: Request): string | null => {
      const fromBody =
        typeof req.body?.parcelNodeId === "string"
          ? req.body.parcelNodeId.trim()
          : "";
      if (fromBody) return fromBody;
      const fromQuery =
        typeof req.query?.parcelNodeId === "string"
          ? req.query.parcelNodeId.trim()
          : "";
      return fromQuery || null;
    });
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = resolvePeOwnerUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parcelNodeId = resolve(req);
    if (await isPePropertyEntitled(userId, parcelNodeId)) {
      next();
      return;
    }
    const tier = await getPeAccessTier(userId);
    res.status(402).json({
      error: "upgrade_required",
      message: parcelNodeId
        ? "Unlock this property or go Pro to run this report"
        : "Paid deep access required for this route",
      tier,
      ...(parcelNodeId
        ? { property: { parcelNodeId, unlocked: false } }
        : {}),
    });
  };
}

function allowlistEnv(name: "PE_DEV_PAID_EMAILS" | "PE_DEV_PAID_SUBJECTS"): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Temporary operator-only paid bypass for deep routes. It is deliberately
 * identity-bound (not a request header) and inert unless an allowlist env is
 * configured. Billing remains the source of truth for every other user.
 */
export async function hasPeDevPaidBypass(userId: string): Promise<boolean> {
  const emails = allowlistEnv("PE_DEV_PAID_EMAILS");
  const subjects = allowlistEnv("PE_DEV_PAID_SUBJECTS");
  if (emails.size === 0 && subjects.size === 0) return false;

  const identities = await db
    .select({
      email: peUserIdentities.email,
      subject: peUserIdentities.subject,
    })
    .from(peUserIdentities)
    .where(eq(peUserIdentities.userId, userId));

  return identities.some(
    (identity) =>
      (identity.email != null && emails.has(identity.email.trim().toLowerCase())) ||
      subjects.has(identity.subject.trim().toLowerCase()),
  );
}

/** Test fixture: flip a user to paid tier (non-production or test header). */
export async function setPeAccessTierForTest(
  userId: string,
  tier: "free" | "paid",
): Promise<void> {
  const { db, peUserEntitlements } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  await import("./peIdentity").then((m) => m.ensurePeEntitlement(userId));
  await db
    .update(peUserEntitlements)
    .set({ accessTier: tier, updatedAt: new Date() })
    .where(eq(peUserEntitlements.ownerUserId, userId));
}
