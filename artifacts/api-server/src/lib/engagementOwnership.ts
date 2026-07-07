/**
 * Per-user engagement ownership predicates (Task #29).
 *
 * Anonymous sessions carry a per-browser ephemeral `anon_*` owner id
 * (see {@link anonymousOwnerCookie.ts}). Signed-in users see only their
 * rows; internal (`audience: internal`) callers bypass owner scoping.
 */

import type { Request, Response } from "express";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  engagements,
  snapshots,
  sheets,
  submissions,
  type Engagement,
} from "@workspace/db";
import type { SessionUser } from "../middlewares/session";
import {
  isAnonymousOwnerId,
  LEGACY_INTERNAL_OWNER_USER_ID,
} from "./anonymousOwnerCookie";

export function isInternalSession(session: SessionUser): boolean {
  return session.audience === "internal";
}

export function sessionOwnerUserId(
  session: SessionUser,
): string | null {
  if (isInternalSession(session)) return null;
  const id = session.requestor?.id;
  return session.requestor?.kind === "user" && id ? id : null;
}

/**
 * True for a verified signed-in user — excludes ephemeral anonymous demo owners.
 * Internal-audience sessions with a user requestor still count (plan-review).
 */
export function isRealSignedInUser(session: SessionUser): boolean {
  const r = session.requestor;
  if (!r || r.kind !== "user") return false;
  return !isAnonymousOwnerId(r.id);
}

/**
 * Owner id used for access checks. Anonymous ephemeral → requestor id;
 * signed-in → requestor id. Returns null when no owner can be resolved.
 */
export function effectiveOwnerUserId(session: SessionUser): string | null {
  if (isInternalSession(session)) return null;
  return sessionOwnerUserId(session);
}

/** SQL fragment scoping engagements to the session owner (or true for internal). */
export function engagementOwnerWhere(session: SessionUser): SQL | undefined {
  if (isInternalSession(session)) return undefined;
  const owner = effectiveOwnerUserId(session);
  if (!owner) return sql`false`;
  if (
    process.env.NODE_ENV === "test" &&
    isAnonymousOwnerId(owner)
  ) {
    return or(
      eq(engagements.ownerUserId, owner),
      eq(engagements.ownerUserId, LEGACY_INTERNAL_OWNER_USER_ID),
    );
  }
  return eq(engagements.ownerUserId, owner);
}

/** Row-level ownership check mirroring {@link engagementOwnerWhere}. */
export function engagementOwnedBySession(
  ownerUserId: string,
  session: SessionUser,
): boolean {
  if (isInternalSession(session)) return true;
  const caller = effectiveOwnerUserId(session);
  if (!caller) return false;
  if (ownerUserId === caller) return true;
  if (
    process.env.NODE_ENV === "test" &&
    isAnonymousOwnerId(caller) &&
    ownerUserId === LEGACY_INTERNAL_OWNER_USER_ID
  ) {
    return true;
  }
  return false;
}

export function engagementOwnerAnd(
  session: SessionUser,
  ...parts: (SQL | undefined)[]
): SQL | undefined {
  const owner = engagementOwnerWhere(session);
  const filtered = parts.filter((p): p is SQL => p !== undefined);
  if (!owner && filtered.length === 0) return undefined;
  if (!owner) return and(...filtered);
  if (filtered.length === 0) return owner;
  return and(owner, ...filtered);
}

/**
 * Require a signed-in user (Phase 2 personal features — inbox, Canva, etc.).
 * Demo engagement routes must NOT call this.
 * Returns true if a 401 was sent.
 */
export function requireAuthenticatedUser(
  req: Request,
  res: Response,
): boolean {
  if (isInternalSession(req.session)) return false;
  if (isRealSignedInUser(req.session)) return false;
  res.status(401).json({ error: "authentication_required" });
  return true;
}

/**
 * Verify the engagement row belongs to the session owner.
 * Returns true if a 403/404 was sent.
 */
export function denyEngagementAccess(
  ownerUserId: string | null | undefined,
  session: SessionUser,
  res: Response,
  notFound = true,
): boolean {
  if (isInternalSession(session)) return false;
  const caller = effectiveOwnerUserId(session);
  if (!caller) {
    res.status(401).json({ error: "authentication_required" });
    return true;
  }
  if (
    ownerUserId == null ||
    !engagementOwnedBySession(ownerUserId, session)
  ) {
    res
      .status(notFound ? 404 : 403)
      .json({ error: notFound ? "engagement_not_found" : "engagement_forbidden" });
    return true;
  }
  return false;
}

export async function loadEngagementForSession(
  engagementId: string,
  session: SessionUser,
  serviceAuth?: { tenantId: string; jurisdictionTenant: string | null; platformInternal: boolean },
): Promise<
  | { ok: true; engagement: Engagement }
  | { ok: false; status: 401 | 404; error: string }
> {
  // Service-token authenticated requests get reviewer-grade access (skip owner filter)
  const skipOwnerFilter = serviceAuth !== undefined;
  const [row] = await db
    .select()
    .from(engagements)
    .where(
      skipOwnerFilter
        ? eq(engagements.id, engagementId)
        : (engagementOwnerAnd(session, eq(engagements.id, engagementId)) ??
            eq(engagements.id, engagementId)),
    )
    .limit(1);
  if (!row) {
    return { ok: false, status: 404, error: "engagement_not_found" };
  }
  return { ok: true, engagement: row };
}

export async function loadSubmissionForSession(
  submissionId: string,
  session: SessionUser,
  serviceAuth?: { tenantId: string; jurisdictionTenant: string | null; platformInternal: boolean },
): Promise<
  | { ok: true; submission: typeof submissions.$inferSelect; engagement: Engagement }
  | { ok: false; status: 401 | 404; error: string }
> {
  const [row] = await db
    .select({
      submission: submissions,
      engagement: engagements,
    })
    .from(submissions)
    .innerJoin(engagements, eq(submissions.engagementId, engagements.id))
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (!row) {
    return { ok: false, status: 404, error: "submission_not_found" };
  }
  // Service-token requests get reviewer-grade access — same rule as
  // loadEngagementForSession above (the command center drives the plan-review
  // lifecycle through the proxy's service key).
  if (serviceAuth !== undefined) {
    return {
      ok: true,
      submission: row.submission,
      engagement: row.engagement,
    };
  }
  if (isInternalSession(session)) {
    return {
      ok: true,
      submission: row.submission,
      engagement: row.engagement,
    };
  }
  const caller = effectiveOwnerUserId(session);
  if (!caller) {
    return { ok: false, status: 401, error: "authentication_required" };
  }
  if (!engagementOwnedBySession(row.engagement.ownerUserId, session)) {
    return { ok: false, status: 404, error: "submission_not_found" };
  }
  return {
    ok: true,
    submission: row.submission,
    engagement: row.engagement,
  };
}

export async function loadSnapshotForSession(
  snapshotId: string,
  session: SessionUser,
): Promise<
  | {
      ok: true;
      snapshot: typeof snapshots.$inferSelect;
      engagement: Engagement;
    }
  | { ok: false; status: 401 | 404; error: string }
> {
  const [row] = await db
    .select({
      snapshot: snapshots,
      engagement: engagements,
    })
    .from(snapshots)
    .innerJoin(engagements, eq(snapshots.engagementId, engagements.id))
    .where(
      engagementOwnerAnd(session, eq(snapshots.id, snapshotId)) ??
        eq(snapshots.id, snapshotId),
    )
    .limit(1);
  if (!row) {
    return { ok: false, status: 404, error: "Snapshot not found" };
  }
  return { ok: true, snapshot: row.snapshot, engagement: row.engagement };
}

export async function loadSheetForSession(
  sheetId: string,
  session: SessionUser,
): Promise<
  | {
      ok: true;
      sheet: typeof sheets.$inferSelect;
      engagement: Engagement;
    }
  | { ok: false; status: 401 | 404; error: string }
> {
  const [row] = await db
    .select({
      sheet: sheets,
      engagement: engagements,
    })
    .from(sheets)
    .innerJoin(engagements, eq(sheets.engagementId, engagements.id))
    .where(
      engagementOwnerAnd(session, eq(sheets.id, sheetId)) ??
        eq(sheets.id, sheetId),
    )
    .limit(1);
  if (!row) {
    return { ok: false, status: 404, error: "sheet_not_found" };
  }
  return { ok: true, sheet: row.sheet, engagement: row.engagement };
}

export function shouldEnsureUserProfile(userId: string): boolean {
  return !isAnonymousOwnerId(userId);
}

/**
 * QA-30/31 follow-up — render routes require engagement ownership
 * (replaces the removed requireArchitectAudience gate).
 */
export function requireEngagementOwnerForRenders(
  req: Request,
  res: Response,
  ownerUserId: string | null | undefined,
): boolean {
  if (isInternalSession(req.session)) return false;
  return denyEngagementAccess(ownerUserId, req.session, res, true);
}
