/**
 * Property Explorer team roster — server half of the Settings Team tab.
 *
 * Client parser (hauska-map origin/main teamClient.ts) is the contract.
 * Seat enforcement lives here, not in the client. An invitation holds a
 * seat from send. The last JOINED owner cannot be removed or demoted.
 *
 * Reuses pe_user_identities / pe_user_entitlements / users. No second
 * user table. seats_purchased is read from the entitlement row; this
 * card does not write Stripe.
 */

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  peTeamInvitations,
  peTeamMembers,
  peUserEntitlements,
  peUserIdentities,
  users,
  type PeTeamRole,
} from "@workspace/db";
import { ensurePeEntitlement } from "./peIdentity";

export const PE_TEAM_ERRORS = {
  AUTHENTICATION_REQUIRED: "authentication_required",
  OWNER_REQUIRED: "owner_required",
  SEAT_CAPACITY_EXCEEDED: "seat_capacity_exceeded",
  SEATS_PURCHASED_UNKNOWN: "seats_purchased_unknown",
  LAST_JOINED_OWNER: "last_joined_owner",
  INVALID_ROLE: "invalid_role",
  INVALID_EMAIL: "invalid_email",
  ALREADY_ON_ROSTER: "already_on_roster",
  INVITATION_NOT_FOUND: "invitation_not_found",
  MEMBER_NOT_FOUND: "member_not_found",
  VIEWER_EMAIL_UNRESOLVED: "viewer_email_unresolved",
} as const;

export type PeTeamErrorName =
  (typeof PE_TEAM_ERRORS)[keyof typeof PE_TEAM_ERRORS];

export class PeTeamError extends Error {
  readonly error: PeTeamErrorName;
  readonly status: number;

  constructor(error: PeTeamErrorName, status: number, message?: string) {
    super(message ?? error);
    this.name = "PeTeamError";
    this.error = error;
    this.status = status;
  }
}

export type TeamWireRole = "owner" | "member";
export type TeamWireStatus = "joined" | "invited";

export type TeamWireMember = {
  email: string;
  role: TeamWireRole;
  status: TeamWireStatus;
  at: string | null;
};

export type TeamRosterWire = {
  members: TeamWireMember[];
  viewerEmail: string;
  viewerRole: TeamWireRole;
  seatsPurchased?: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeTeamEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

export function asTeamRole(raw: unknown): TeamWireRole | null {
  return raw === "owner" || raw === "member" ? raw : null;
}

/** Drop a row whose role is not owner|member. Never emit a third role. */
export function toWireMember(row: {
  email: string;
  role: unknown;
  status: TeamWireStatus;
  at: Date | string | null;
}): TeamWireMember | null {
  const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
  const role = asTeamRole(row.role);
  if (!email || !role) return null;
  const at =
    row.at instanceof Date
      ? row.at.toISOString()
      : typeof row.at === "string"
        ? row.at
        : null;
  return { email, role, status: row.status, at };
}

/**
 * seatsPurchased is a number or ABSENT. Never 0 to mean unknown.
 * No team subscription → omit. Team with a stored number → emit it
 * (0 included, because 0 is a fact). Team with a null column → omit.
 */
export function seatsPurchasedForWire(input: {
  subscriptionTier: string | null;
  seatsPurchased: number | null;
}): number | undefined {
  if (input.subscriptionTier !== "team") return undefined;
  if (typeof input.seatsPurchased !== "number") return undefined;
  return input.seatsPurchased;
}

export function consumedSeatCount(input: {
  joinedCount: number;
  invitedCount: number;
}): number {
  return input.joinedCount + input.invitedCount;
}

async function resolveViewerEmail(userId: string): Promise<string | null> {
  const [identity] = await db
    .select({ email: peUserIdentities.email })
    .from(peUserIdentities)
    .where(eq(peUserIdentities.userId, userId))
    .limit(1);
  const fromIdentity = normalizeTeamEmail(identity?.email);
  if (fromIdentity) return fromIdentity;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return normalizeTeamEmail(user?.email);
}

async function ensureOwnerMembership(
  userId: string,
  email: string,
): Promise<void> {
  await db
    .insert(peTeamMembers)
    .values({
      accountOwnerUserId: userId,
      memberUserId: userId,
      email,
      role: "owner",
    })
    .onConflictDoNothing();
}

type ViewerAccount = {
  accountOwnerUserId: string;
  viewerEmail: string;
  viewerRole: TeamWireRole;
};

async function resolveViewerAccount(userId: string): Promise<ViewerAccount> {
  const [membership] = await db
    .select({
      accountOwnerUserId: peTeamMembers.accountOwnerUserId,
      email: peTeamMembers.email,
      role: peTeamMembers.role,
    })
    .from(peTeamMembers)
    .where(eq(peTeamMembers.memberUserId, userId))
    .limit(1);
  if (membership) {
    const role = asTeamRole(membership.role);
    if (!role) {
      throw new PeTeamError(PE_TEAM_ERRORS.INVALID_ROLE, 422);
    }
    return {
      accountOwnerUserId: membership.accountOwnerUserId,
      viewerEmail: membership.email,
      viewerRole: role,
    };
  }
  const email = await resolveViewerEmail(userId);
  if (!email) {
    throw new PeTeamError(PE_TEAM_ERRORS.VIEWER_EMAIL_UNRESOLVED, 422);
  }
  await ensurePeEntitlement(userId);
  await ensureOwnerMembership(userId, email);
  return {
    accountOwnerUserId: userId,
    viewerEmail: email,
    viewerRole: "owner",
  };
}

async function loadEntitlement(accountOwnerUserId: string): Promise<{
  subscriptionTier: string | null;
  seatsPurchased: number | null;
}> {
  const [row] = await db
    .select({
      subscriptionTier: peUserEntitlements.subscriptionTier,
      seatsPurchased: peUserEntitlements.seatsPurchased,
    })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, accountOwnerUserId))
    .limit(1);
  return {
    subscriptionTier: row?.subscriptionTier ?? null,
    seatsPurchased:
      typeof row?.seatsPurchased === "number" ? row.seatsPurchased : null,
  };
}

async function listWireMembers(
  accountOwnerUserId: string,
): Promise<TeamWireMember[]> {
  const [joined, invited] = await Promise.all([
    db
      .select()
      .from(peTeamMembers)
      .where(eq(peTeamMembers.accountOwnerUserId, accountOwnerUserId)),
    db
      .select()
      .from(peTeamInvitations)
      .where(eq(peTeamInvitations.accountOwnerUserId, accountOwnerUserId)),
  ]);
  const members: TeamWireMember[] = [];
  for (const row of joined) {
    const wire = toWireMember({
      email: row.email,
      role: row.role,
      status: "joined",
      at: row.joinedAt,
    });
    if (wire) members.push(wire);
  }
  for (const row of invited) {
    const wire = toWireMember({
      email: row.email,
      role: row.role,
      status: "invited",
      at: row.sentAt,
    });
    if (wire) members.push(wire);
  }
  members.sort((a, b) => a.email.localeCompare(b.email));
  return members;
}

function requireOwner(viewerRole: TeamWireRole): void {
  if (viewerRole !== "owner") {
    throw new PeTeamError(PE_TEAM_ERRORS.OWNER_REQUIRED, 403);
  }
}

function joinedOwnerCount(members: TeamWireMember[]): number {
  return members.filter((m) => m.role === "owner" && m.status === "joined")
    .length;
}

export async function readTeamRoster(userId: string): Promise<TeamRosterWire> {
  const viewer = await resolveViewerAccount(userId);
  const [ent, members] = await Promise.all([
    loadEntitlement(viewer.accountOwnerUserId),
    listWireMembers(viewer.accountOwnerUserId),
  ]);
  const seats = seatsPurchasedForWire(ent);
  const body: TeamRosterWire = {
    members,
    viewerEmail: viewer.viewerEmail,
    viewerRole: viewer.viewerRole,
  };
  if (seats !== undefined) body.seatsPurchased = seats;
  return body;
}

export async function createTeamInvitation(
  userId: string,
  input: { email: unknown; role: unknown },
): Promise<{ id: string; email: string; role: TeamWireRole }> {
  const viewer = await resolveViewerAccount(userId);
  requireOwner(viewer.viewerRole);
  const email = normalizeTeamEmail(input.email);
  if (!email) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVALID_EMAIL, 400);
  }
  const role = asTeamRole(input.role);
  if (!role) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVALID_ROLE, 400);
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT owner_user_id FROM pe_user_entitlements WHERE owner_user_id = ${viewer.accountOwnerUserId} FOR UPDATE`,
    );
    const [ent] = await tx
      .select({
        subscriptionTier: peUserEntitlements.subscriptionTier,
        seatsPurchased: peUserEntitlements.seatsPurchased,
      })
      .from(peUserEntitlements)
      .where(eq(peUserEntitlements.ownerUserId, viewer.accountOwnerUserId))
      .limit(1);
    const seats = seatsPurchasedForWire({
      subscriptionTier: ent?.subscriptionTier ?? null,
      seatsPurchased:
        typeof ent?.seatsPurchased === "number" ? ent.seatsPurchased : null,
    });
    if (seats === undefined) {
      throw new PeTeamError(PE_TEAM_ERRORS.SEATS_PURCHASED_UNKNOWN, 409);
    }

    const [joinedRows, invitedRows] = await Promise.all([
      tx
        .select({ email: peTeamMembers.email })
        .from(peTeamMembers)
        .where(eq(peTeamMembers.accountOwnerUserId, viewer.accountOwnerUserId)),
      tx
        .select({ email: peTeamInvitations.email })
        .from(peTeamInvitations)
        .where(
          eq(peTeamInvitations.accountOwnerUserId, viewer.accountOwnerUserId),
        ),
    ]);
    const onRoster = new Set([
      ...joinedRows.map((r) => r.email),
      ...invitedRows.map((r) => r.email),
    ]);
    if (onRoster.has(email)) {
      throw new PeTeamError(PE_TEAM_ERRORS.ALREADY_ON_ROSTER, 409);
    }
    const consumed = consumedSeatCount({
      joinedCount: joinedRows.length,
      invitedCount: invitedRows.length,
    });
    if (consumed >= seats) {
      throw new PeTeamError(PE_TEAM_ERRORS.SEAT_CAPACITY_EXCEEDED, 409);
    }

    const id = `pti_${randomBytes(16).toString("hex")}`;
    await tx.insert(peTeamInvitations).values({
      id,
      accountOwnerUserId: viewer.accountOwnerUserId,
      email,
      role,
    });
    return { id, email, role };
  });
}

export async function cancelTeamInvitation(
  userId: string,
  invitationId: string,
): Promise<void> {
  const viewer = await resolveViewerAccount(userId);
  requireOwner(viewer.viewerRole);
  const deleted = await db
    .delete(peTeamInvitations)
    .where(
      and(
        eq(peTeamInvitations.id, invitationId),
        eq(peTeamInvitations.accountOwnerUserId, viewer.accountOwnerUserId),
      ),
    )
    .returning({ id: peTeamInvitations.id });
  if (deleted.length === 0) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVITATION_NOT_FOUND, 404);
  }
}

export async function removeTeamMember(
  userId: string,
  rawEmail: string,
): Promise<void> {
  const viewer = await resolveViewerAccount(userId);
  requireOwner(viewer.viewerRole);
  const email = normalizeTeamEmail(decodeURIComponent(rawEmail));
  if (!email) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVALID_EMAIL, 400);
  }
  const members = await listWireMembers(viewer.accountOwnerUserId);
  const target = members.find((m) => m.email === email && m.status === "joined");
  if (!target) {
    throw new PeTeamError(PE_TEAM_ERRORS.MEMBER_NOT_FOUND, 404);
  }
  if (target.role === "owner" && joinedOwnerCount(members) === 1) {
    throw new PeTeamError(PE_TEAM_ERRORS.LAST_JOINED_OWNER, 409);
  }
  const deleted = await db
    .delete(peTeamMembers)
    .where(
      and(
        eq(peTeamMembers.accountOwnerUserId, viewer.accountOwnerUserId),
        eq(peTeamMembers.email, email),
      ),
    )
    .returning({ email: peTeamMembers.email });
  if (deleted.length === 0) {
    throw new PeTeamError(PE_TEAM_ERRORS.MEMBER_NOT_FOUND, 404);
  }
}

export async function patchTeamMemberRole(
  userId: string,
  rawEmail: string,
  rawRole: unknown,
): Promise<void> {
  const viewer = await resolveViewerAccount(userId);
  requireOwner(viewer.viewerRole);
  const email = normalizeTeamEmail(decodeURIComponent(rawEmail));
  if (!email) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVALID_EMAIL, 400);
  }
  const role = asTeamRole(rawRole);
  if (!role) {
    throw new PeTeamError(PE_TEAM_ERRORS.INVALID_ROLE, 400);
  }
  const members = await listWireMembers(viewer.accountOwnerUserId);
  const target = members.find((m) => m.email === email && m.status === "joined");
  if (!target) {
    throw new PeTeamError(PE_TEAM_ERRORS.MEMBER_NOT_FOUND, 404);
  }
  if (
    target.role === "owner" &&
    role === "member" &&
    joinedOwnerCount(members) === 1
  ) {
    throw new PeTeamError(PE_TEAM_ERRORS.LAST_JOINED_OWNER, 409);
  }
  const updated = await db
    .update(peTeamMembers)
    .set({ role })
    .where(
      and(
        eq(peTeamMembers.accountOwnerUserId, viewer.accountOwnerUserId),
        eq(peTeamMembers.email, email),
      ),
    )
    .returning({ email: peTeamMembers.email });
  if (updated.length === 0) {
    throw new PeTeamError(PE_TEAM_ERRORS.MEMBER_NOT_FOUND, 404);
  }
}

export function teamErrorBody(err: unknown): {
  status: number;
  body: { error: string };
} {
  if (err instanceof PeTeamError) {
    return { status: err.status, body: { error: err.error } };
  }
  throw err;
}
