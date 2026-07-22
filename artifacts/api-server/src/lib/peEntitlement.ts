/**
 * Property Explorer entitlement resolution and deep-route gate helpers.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getPeAccessTier } from "./peIdentity";
import { isAnonymousOwnerId } from "./anonymousOwnerCookie";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

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
