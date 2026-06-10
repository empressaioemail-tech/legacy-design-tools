/**
 * Per-user engagement ownership predicates (Task #29).
 *
 * Phase 1 (phased-7k): anonymous sessions scope to {@link MIGRATION_OWNER_USER_ID}
 * — the 0038 backfill owner — so the instant demo works without login.
 *
 * Phase 2: signed-in users (`session.requestor`) see only their own rows;
 * internal (`audience: internal`) callers bypass owner scoping for plan-review.
 */

import type { Request, Response } from "express";
import { and, eq, type SQL } from "drizzle-orm";
import { db, engagements, submissions, type Engagement } from "@workspace/db";
import type { SessionUser } from "../middlewares/session";
import { MIGRATION_OWNER_USER_ID } from "./sessionToken";

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
 * Demo/anonymous owner id. Migration 0038 backfilled legacy engagements here;
 * anonymous create/read paths use the same id so existing data stays reachable.
 */
export function anonymousOwnerUserId(): string {
  return MIGRATION_OWNER_USER_ID;
}

/**
 * Owner id used for access checks. Anonymous → demo owner; signed-in → requestor id.
 */
export function effectiveOwnerUserId(session: SessionUser): string | null {
  if (isInternalSession(session)) return null;
  return sessionOwnerUserId(session) ?? anonymousOwnerUserId();
}

/** SQL fragment scoping engagements to the session owner (or true for internal). */
export function engagementOwnerWhere(session: SessionUser): SQL | undefined {
  if (isInternalSession(session)) return undefined;
  return eq(engagements.ownerUserId, effectiveOwnerUserId(session)!);
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
  if (sessionOwnerUserId(req.session)) return false;
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
  if (ownerUserId !== caller) {
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
): Promise<
  | { ok: true; engagement: Engagement }
  | { ok: false; status: 401 | 404; error: string }
> {
  const [row] = await db
    .select()
    .from(engagements)
    .where(
      engagementOwnerAnd(session, eq(engagements.id, engagementId)) ??
        eq(engagements.id, engagementId),
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
  if (row.engagement.ownerUserId !== caller) {
    return { ok: false, status: 404, error: "submission_not_found" };
  }
  return {
    ok: true,
    submission: row.submission,
    engagement: row.engagement,
  };
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
