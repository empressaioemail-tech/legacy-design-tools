/**
 * P-94 Team roster — violate-then-pass against the table, not only the
 * response. Client parser shape is hauska-map origin/main teamClient.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq, sql } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  peTeamInvitations,
  peTeamMembers,
  peUserEntitlements,
  peUserIdentities,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { PE_TEAM_ERRORS } from "../lib/peTeamRoster";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-team-roster: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const OWNER = "user-team-owner";
const MEMBER = "user-team-member";
const OWNER_EMAIL = "owner@roster.test";
const MEMBER_EMAIL = "member@roster.test";
const INVITE_EMAIL = "invitee@roster.test";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

async function seedUser(input: {
  id: string;
  email: string;
  subscriptionTier?: "solo" | "studio" | "team" | null;
  seatsPurchased?: number | null;
  accessTier?: "free" | "paid";
}): Promise<void> {
  await db.insert(users).values({
    id: input.id,
    displayName: input.email,
    email: input.email,
  });
  await db.insert(peUserIdentities).values({
    id: `pei_google_${input.id}`,
    userId: input.id,
    provider: "google",
    subject: `sub-${input.id}`,
    email: input.email,
  });
  await db.insert(peUserEntitlements).values({
    ownerUserId: input.id,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: input.accessTier ?? (input.subscriptionTier ? "paid" : "free"),
    subscriptionTier: input.subscriptionTier ?? null,
    seatsPurchased: input.seatsPurchased ?? null,
  });
}

async function invitationCount(accountOwnerUserId: string): Promise<number> {
  const rows = await db
    .select({ email: peTeamInvitations.email })
    .from(peTeamInvitations)
    .where(eq(peTeamInvitations.accountOwnerUserId, accountOwnerUserId));
  return rows.length;
}

async function memberCount(accountOwnerUserId: string): Promise<number> {
  const rows = await db
    .select({ email: peTeamMembers.email })
    .from(peTeamMembers)
    .where(eq(peTeamMembers.accountOwnerUserId, accountOwnerUserId));
  return rows.length;
}

describe("PE team roster", () => {
  beforeEach(async () => {
    await seedUser({
      id: OWNER,
      email: OWNER_EMAIL,
      subscriptionTier: "team",
      seatsPurchased: 2,
    });
    await seedUser({
      id: MEMBER,
      email: MEMBER_EMAIL,
      subscriptionTier: null,
    });
  });

  it("401 when there is no session", async () => {
    const res = await request(getApp()).get(
      "/api/property-explorer/v1/team/members",
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.AUTHENTICATION_REQUIRED);
  });

  it("GET returns the client parser shape; owner is a joined owner", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    expect(res.status).toBe(200);
    expect(res.body.viewerEmail).toBe(OWNER_EMAIL);
    expect(res.body.viewerRole).toBe("owner");
    expect(res.body.seatsPurchased).toBe(2);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members).toEqual([
      {
        email: OWNER_EMAIL,
        role: "owner",
        status: "joined",
        at: expect.any(String),
      },
    ]);
    expect(await memberCount(OWNER)).toBe(1);
  });

  it("omits seatsPurchased when the account has no team subscription", async () => {
    const solo = "user-solo";
    await seedUser({
      id: solo,
      email: "solo@roster.test",
      subscriptionTier: "solo",
      seatsPurchased: null,
      accessTier: "paid",
    });
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      solo,
    );
    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, "seatsPurchased")).toBe(
      false,
    );
    expect(res.body.seatsPurchased).toBeUndefined();
  });

  it("POST invitation writes a row that holds a seat before accept", async () => {
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: INVITE_EMAIL, role: "member" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(INVITE_EMAIL);
    expect(res.body.role).toBe("member");
    expect(res.body.id).toMatch(/^pti_/);

    const rows = await db
      .select()
      .from(peTeamInvitations)
      .where(eq(peTeamInvitations.accountOwnerUserId, OWNER));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(INVITE_EMAIL);

    const get = await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    expect(get.body.members).toHaveLength(2);
    const invited = get.body.members.find(
      (m: { email: string }) => m.email === INVITE_EMAIL,
    );
    expect(invited).toMatchObject({
      email: INVITE_EMAIL,
      role: "member",
      status: "invited",
    });
  });

  it("VIOLATION: POST at capacity is refused with a named error and no row", async () => {
    const first = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: INVITE_EMAIL, role: "member" });
    expect(first.status).toBe(201);
    expect(await invitationCount(OWNER)).toBe(1);

    const before = await invitationCount(OWNER);
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: "overflow@roster.test", role: "member" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.SEAT_CAPACITY_EXCEEDED);
    expect(await invitationCount(OWNER)).toBe(before);
    const overflow = await db
      .select()
      .from(peTeamInvitations)
      .where(eq(peTeamInvitations.email, "overflow@roster.test"));
    expect(overflow).toHaveLength(0);
  });

  it("does not silently cap: over-capacity is 409, never 200", async () => {
    await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: INVITE_EMAIL, role: "member" });
    const res = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: "queued@roster.test", role: "member" });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.SEAT_CAPACITY_EXCEEDED);
  });

  it("VIOLATION: DELETE the only joined owner is refused; table unchanged", async () => {
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    const before = await memberCount(OWNER);
    const res = await asUser(
      request(getApp()).delete(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(OWNER_EMAIL)}`,
      ),
      OWNER,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.LAST_JOINED_OWNER);
    expect(await memberCount(OWNER)).toBe(before);
    const [row] = await db
      .select()
      .from(peTeamMembers)
      .where(eq(peTeamMembers.memberUserId, OWNER));
    expect(row?.role).toBe("owner");
  });

  it("VIOLATION: PATCH the only joined owner to member is refused; table unchanged", async () => {
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    const res = await asUser(
      request(getApp()).patch(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(OWNER_EMAIL)}`,
      ),
      OWNER,
    ).send({ role: "member" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.LAST_JOINED_OWNER);
    const [row] = await db
      .select()
      .from(peTeamMembers)
      .where(eq(peTeamMembers.memberUserId, OWNER));
    expect(row?.role).toBe("owner");
  });

  it("an invited owner does not count as the last joined owner", async () => {
    await db
      .update(peUserEntitlements)
      .set({ seatsPurchased: 3 })
      .where(eq(peUserEntitlements.ownerUserId, OWNER));
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    const invite = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: "second-owner@roster.test", role: "owner" });
    expect(invite.status).toBe(201);
    const res = await asUser(
      request(getApp()).delete(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(OWNER_EMAIL)}`,
      ),
      OWNER,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PE_TEAM_ERRORS.LAST_JOINED_OWNER);
  });

  it("member session cannot invite or remove", async () => {
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    await db.insert(peTeamMembers).values({
      accountOwnerUserId: OWNER,
      memberUserId: MEMBER,
      email: MEMBER_EMAIL,
      role: "member",
    });
    const beforeInvites = await invitationCount(OWNER);
    const invite = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      MEMBER,
    ).send({ email: "member-invite@roster.test", role: "member" });
    expect(invite.status).toBe(403);
    expect(invite.body.error).toBe(PE_TEAM_ERRORS.OWNER_REQUIRED);
    expect(await invitationCount(OWNER)).toBe(beforeInvites);

    const remove = await asUser(
      request(getApp()).delete(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(OWNER_EMAIL)}`,
      ),
      MEMBER,
    );
    expect(remove.status).toBe(403);
    expect(remove.body.error).toBe(PE_TEAM_ERRORS.OWNER_REQUIRED);
    expect(await memberCount(OWNER)).toBe(2);
  });

  it("DELETE invitation and PATCH/DELETE member succeed for a non-last owner target", async () => {
    await db
      .update(peUserEntitlements)
      .set({ seatsPurchased: 4 })
      .where(eq(peUserEntitlements.ownerUserId, OWNER));
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    const invite = await asUser(
      request(getApp()).post("/api/property-explorer/v1/team/invitations"),
      OWNER,
    ).send({ email: INVITE_EMAIL, role: "member" });
    expect(invite.status).toBe(201);
    const cancel = await asUser(
      request(getApp()).delete(
        `/api/property-explorer/v1/team/invitations/${invite.body.id}`,
      ),
      OWNER,
    );
    expect(cancel.status).toBe(204);
    expect(await invitationCount(OWNER)).toBe(0);

    await db.insert(peTeamMembers).values({
      accountOwnerUserId: OWNER,
      memberUserId: MEMBER,
      email: MEMBER_EMAIL,
      role: "member",
    });
    const promote = await asUser(
      request(getApp()).patch(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(MEMBER_EMAIL)}`,
      ),
      OWNER,
    ).send({ role: "owner" });
    expect(promote.status).toBe(204);
    const [promoted] = await db
      .select()
      .from(peTeamMembers)
      .where(eq(peTeamMembers.memberUserId, MEMBER));
    expect(promoted?.role).toBe("owner");

    const demote = await asUser(
      request(getApp()).patch(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(MEMBER_EMAIL)}`,
      ),
      OWNER,
    ).send({ role: "member" });
    expect(demote.status).toBe(204);

    const remove = await asUser(
      request(getApp()).delete(
        `/api/property-explorer/v1/team/members/${encodeURIComponent(MEMBER_EMAIL)}`,
      ),
      OWNER,
    );
    expect(remove.status).toBe(204);
    expect(await memberCount(OWNER)).toBe(1);
  });

  it("CHECK refuses a planted administrator role; serializer would drop it anyway", async () => {
    await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    let planted: unknown;
    try {
      await ctx.schema!.db.execute(
        sql`INSERT INTO pe_team_members (account_owner_user_id, member_user_id, email, role)
            VALUES (${OWNER}, ${MEMBER}, ${"admin@roster.test"}, ${"administrator"})`,
      );
    } catch (err) {
      planted = err;
    }
    expect(planted, "expected the administrator insert to reject").toBeDefined();
    const text = [
      planted instanceof Error ? planted.message : String(planted),
      planted instanceof Error && planted.cause instanceof Error
        ? planted.cause.message
        : "",
    ].join("\n");
    expect(text).toMatch(/pe_team_members_role_chk|check constraint/i);

    const get = await asUser(
      request(getApp()).get("/api/property-explorer/v1/team/members"),
      OWNER,
    );
    expect(
      get.body.members.some((m: { role: string }) => m.role === "administrator"),
    ).toBe(false);
    expect(
      get.body.members.every(
        (m: { role: string }) => m.role === "owner" || m.role === "member",
      ),
    ).toBe(true);
  });
});
