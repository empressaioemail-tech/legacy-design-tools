/**
 * P-98 activation events — violate-then-pass against the TABLE, not only the
 * response status.
 *
 * Every refusal case asserts that ZERO rows were written. A 400 whose body
 * says "refused" while a row lands anyway is the failure this route exists to
 * prevent, and a status-only assertion cannot see it.
 *
 * The pure-validator half of this coverage is in
 * `src/lib/__tests__/peActivationEventsValidate.test.ts`, which needs no
 * database and therefore runs on a developer machine. This file proves the
 * WIRING: that the route reaches that validator, that a refusal writes
 * nothing, and that the row is attributed to the session rather than to the
 * request body.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  peActivationEvents,
  peUserEntitlements,
  peUserIdentities,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import {
  PE_ACTIVATION_ACTION_IDS,
  PE_ACTIVATION_EVENT_TYPES,
} from "../lib/peActivationEventsValidate";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-activation-events: ctx.schema not set");
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

const ROUTE = "/api/property-explorer/v1/activation-events";
const USER = "user-activation-events";
const OTHER = "user-activation-other";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({
    id,
    displayName: `${id}@activation.test`,
    email: `${id}@activation.test`,
  });
  await db.insert(peUserIdentities).values({
    id: `pei_google_${id}`,
    userId: id,
    provider: "google",
    subject: `sub-${id}`,
    email: `${id}@activation.test`,
  });
  await db.insert(peUserEntitlements).values({
    ownerUserId: id,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: "free",
    subscriptionTier: null,
  });
}

async function allEvents(): Promise<
  { ownerUserId: string; eventType: string; actionId: string; surface: string | null }[]
> {
  return db
    .select({
      ownerUserId: peActivationEvents.ownerUserId,
      eventType: peActivationEvents.eventType,
      actionId: peActivationEvents.actionId,
      surface: peActivationEvents.surface,
    })
    .from(peActivationEvents);
}

describe("PE activation events", () => {
  beforeEach(async () => {
    await seedUser(USER);
    await seedUser(OTHER);
  });

  describe("authentication", () => {
    it("401 and writes nothing when there is no session", async () => {
      const res = await request(getApp())
        .post(ROUTE)
        .send({ event_type: "shown", action_id: "connect_claude" });
      expect(res.status).toBe(401);
      expect(await allEvents()).toHaveLength(0);
    });
  });

  describe("the accepted direction", () => {
    it("201 records a shown event and stores surface as NULL when absent", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
        action_id: "connect_claude",
      });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.event.eventType).toBe("shown");
      expect(res.body.event.actionId).toBe("connect_claude");
      // NOT "api". gtm_events defaults its surface; this one must not.
      expect(res.body.event.surface).toBeNull();
      expect(typeof res.body.event.createdAt).toBe("string");

      const rows = await allEvents();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ownerUserId: USER,
        eventType: "shown",
        actionId: "connect_claude",
        surface: null,
      });
    });

    it("201 records an acted event with its surface", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "acted",
        action_id: "annual_upgrade",
        surface: "settings_modal",
      });

      expect(res.status).toBe(201);
      const rows = await allEvents();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: "acted",
        actionId: "annual_upgrade",
        surface: "settings_modal",
      });
    });

    it.each([...PE_ACTIVATION_ACTION_IDS])(
      "accepts the ladder rung %s",
      async (actionId) => {
        const res = await asUser(request(getApp()).post(ROUTE), USER).send({
          event_type: "shown",
          action_id: actionId,
        });
        expect(res.status).toBe(201);
        const rows = await allEvents();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actionId).toBe(actionId);
      },
    );

    it.each([...PE_ACTIVATION_EVENT_TYPES])(
      "accepts the event type %s",
      async (eventType) => {
        const res = await asUser(request(getApp()).post(ROUTE), USER).send({
          event_type: eventType,
          action_id: "team_invite",
        });
        expect(res.status).toBe(201);
        expect((await allEvents())[0]!.eventType).toBe(eventType);
      },
    );
  });

  describe("the refused direction — every case writes NOTHING", () => {
    it("400 on an unrecognised event_type, and names the allowed set", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "clicked",
        action_id: "connect_claude",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_event_type");
      expect(res.body.allowed).toEqual([...PE_ACTIVATION_EVENT_TYPES]);
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on an ABSENT event_type rather than defaulting it", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        action_id: "connect_claude",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_event_type");
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on an invented action_id, and names the allowed set", async () => {
      // An invented action id pollutes the only activation measurement that
      // will exist and is indistinguishable from a real row afterwards.
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
        action_id: "buy_now",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_action_id");
      expect(res.body.allowed).toEqual([...PE_ACTIVATION_ACTION_IDS]);
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on an ABSENT action_id rather than writing a placeholder", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_action_id");
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on an empty-string action_id (the sentinel a NOT NULL admits)", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
        action_id: "",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_action_id");
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on a blank surface rather than coercing it to null", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
        action_id: "connect_claude",
        surface: "   ",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_surface");
      expect(await allEvents()).toHaveLength(0);
    });

    it("400 on an empty body", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({});
      expect(res.status).toBe(400);
      expect(await allEvents()).toHaveLength(0);
    });
  });

  describe("attribution comes from the session, never the body", () => {
    it("ignores an owner_user_id in the body and records the caller", async () => {
      const res = await asUser(request(getApp()).post(ROUTE), USER).send({
        event_type: "shown",
        action_id: "connect_claude",
        owner_user_id: OTHER,
      });
      expect(res.status).toBe(201);

      const rows = await allEvents();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ownerUserId).toBe(USER);

      const othersRows = await db
        .select({ id: peActivationEvents.id })
        .from(peActivationEvents)
        .where(eq(peActivationEvents.ownerUserId, OTHER));
      expect(othersRows).toHaveLength(0);
    });
  });
});
