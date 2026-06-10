/**
 * Per-user engagement ownership predicates (Task #29).
 *
 * Internal (`audience: internal`) callers bypass owner scoping so the
 * plan-review inbox can still cross-read engagements. Applicant sessions
 * (`audience: user`) are filtered to `engagements.owner_user_id`.
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
 * Owner id used for access checks. Outside production, anonymous applicant
 * sessions inherit legacy `migration-owner` rows so existing route tests
 * keep working without minting a user token on every request.
 */
export function effectiveOwnerUserId(session: SessionUser): string | null {
  const ownerId = sessionOwnerUserId(session);
  if (ownerId) return ownerId;
  if (process.env["NODE_ENV"] !== "production") {
    return MIGRATION_OWNER_USER_ID;
  }
  return null;
}

/** SQL fragment scoping engagements to the session owner (or true for internal). */
export function engagementOwnerWhere(session: SessionUser): SQL | undefined {
  if (isInternalSession(session)) return undefined;
  const ownerId = sessionOwnerUserId(session);
  if (!ownerId) {
    if (process.env["NODE_ENV"] !== "production") {
      return eq(engagements.ownerUserId, MIGRATION_OWNER_USER_ID);
    }
    return eq(engagements.ownerUserId, "__no_such_owner__");
  }
  return eq(engagements.ownerUserId, ownerId);
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
 * Require an authenticated user session for applicant-scoped routes.
 * Returns true if a 401 was sent.
 */
export function requireAuthenticatedUser(
  req: Request,
  res: Response,
): boolean {
  if (process.env["NODE_ENV"] !== "production") return false;
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
    if (
      !isInternalSession(session) &&
      !sessionOwnerUserId(session) &&
      process.env["NODE_ENV"] === "production"
    ) {
      return { ok: false, status: 401, error: "authentication_required" };
    }
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
