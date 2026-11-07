/**
 * P-98 account-wide unlock read — the cases that matter are the EXCLUSIONS.
 *
 * A list read is trivially "green" if it returns rows. What has to be proven
 * is what it leaves out and what it refuses to invent:
 *   - an EXPIRED unlock is absent (the same predicate the per-parcel gate uses)
 *   - a NULL-expiry unlock is present with expiresAt null, NOT with a
 *     synthesised unlocked_at + 30 days
 *   - another account's unlocks never appear
 *   - a different tenant does NOT narrow the set
 *
 * The 30-day figure lives in PE_PROPERTY_UNLOCK_DURATION_DAYS and is a
 * WRITE-side constant used by the Stripe webhook. Nothing here derives an
 * expiry from it, and the null-expiry test is what would catch it if someone
 * later did.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  db,
  pePropertyUnlocks,
  peUserEntitlements,
  peUserIdentities,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-entitlement-unlocks: ctx.schema not set");
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

const ROUTE = "/api/property-explorer/v1/entitlement/unlocks";
const USER = "user-unlocks-owner";
const OTHER = "user-unlocks-other";

const DAY_MS = 24 * 60 * 60 * 1000;

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({
    id,
    displayName: `${id}@unlocks.test`,
    email: `${id}@unlocks.test`,
  });
  await db.insert(peUserIdentities).values({
    id: `pei_google_${id}`,
    userId: id,
    provider: "google",
    subject: `sub-${id}`,
    email: `${id}@unlocks.test`,
  });
  await db.insert(peUserEntitlements).values({
    ownerUserId: id,
    tenantId: DEFAULT_TENANT_ID,
    accessTier: "free",
    subscriptionTier: null,
  });
}

async function seedUnlock(input: {
  ownerUserId: string;
  parcelNodeId: string;
  expiresAt: Date | null;
  tenantId?: string;
  source?: string;
}): Promise<void> {
  await db.insert(pePropertyUnlocks).values({
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    parcelNodeId: input.parcelNodeId,
    source: input.source ?? "stripe",
    expiresAt: input.expiresAt,
  });
}

describe("PE account-wide unlocks", () => {
  beforeEach(async () => {
    await seedUser(USER);
    await seedUser(OTHER);
  });

  describe("authentication", () => {
    it("401 when there is no session", async () => {
      const res = await request(getApp()).get(ROUTE);
      expect(res.status).toBe(401);
      // NOT an empty list. An empty list would claim "you have unlocked
      // nothing" about an account that was never identified.
      expect(res.body.unlocks).toBeUndefined();
    });
  });

  describe("the empty case is reachable and honest", () => {
    it("200 with an empty list and an asOf for an account with no unlocks", async () => {
      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.status).toBe(200);
      expect(res.body.unlocks).toEqual([]);
      expect(typeof res.body.asOf).toBe("string");
      expect(Number.isNaN(Date.parse(res.body.asOf))).toBe(false);
    });
  });

  describe("active unlocks are returned with their STORED expiry", () => {
    it("returns a bounded unlock with its expiry", async () => {
      const expiresAt = new Date(Date.now() + 4 * DAY_MS);
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:34137",
        expiresAt,
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.status).toBe(200);
      expect(res.body.unlocks).toHaveLength(1);
      expect(res.body.unlocks[0]).toMatchObject({
        parcelNodeId: "48021:34137",
        tenantId: DEFAULT_TENANT_ID,
        source: "stripe",
      });
      expect(Date.parse(res.body.unlocks[0].expiresAt)).toBe(
        expiresAt.getTime(),
      );
      expect(typeof res.body.unlocks[0].unlockedAt).toBe("string");
    });

    it("returns a NULL-expiry unlock as expiresAt null, never a synthesised date", async () => {
      // A dev/legacy unlock is UNBOUNDED. Deriving unlocked_at + 30 days here
      // would have the rail announce a lapse that does not exist.
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:99999",
        expiresAt: null,
        source: "dev",
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.status).toBe(200);
      expect(res.body.unlocks).toHaveLength(1);
      expect(res.body.unlocks[0].expiresAt).toBeNull();
      expect(res.body.unlocks[0].source).toBe("dev");
    });
  });

  describe("the exclusions", () => {
    it("EXPIRED unlocks are absent", async () => {
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:expired",
        expiresAt: new Date(Date.now() - DAY_MS),
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.status).toBe(200);
      expect(res.body.unlocks).toEqual([]);
    });

    it("keeps the active one and drops the expired one in the same account", async () => {
      // The both-directions case: if the predicate were inverted or dropped,
      // this returns 0 or 2 rather than exactly the active one.
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:expired",
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:active",
        expiresAt: new Date(Date.now() + DAY_MS),
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.body.unlocks).toHaveLength(1);
      expect(res.body.unlocks[0].parcelNodeId).toBe("48021:active");
    });

    it("another account's unlocks never appear", async () => {
      await seedUnlock({
        ownerUserId: OTHER,
        parcelNodeId: "48021:someone-else",
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.body.unlocks).toEqual([]);
    });
  });

  describe("tenant is reported, never used to narrow", () => {
    it("returns an unlock stored under a different tenant", async () => {
      // The question is account-wide. Narrowing to the session tenant would
      // silently hide this row and read as "you have no unlocks".
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:other-tenant",
        tenantId: "some-other-tenant",
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(res.body.unlocks).toHaveLength(1);
      expect(res.body.unlocks[0].tenantId).toBe("some-other-tenant");
    });
  });

  describe("ordering: soonest lapse first, unbounded last", () => {
    it("sorts by expiry with null-expiry unlocks at the end", async () => {
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:unbounded",
        expiresAt: null,
      });
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:later",
        expiresAt: new Date(Date.now() + 20 * DAY_MS),
      });
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:soonest",
        expiresAt: new Date(Date.now() + 2 * DAY_MS),
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      expect(
        res.body.unlocks.map((u: { parcelNodeId: string }) => u.parcelNodeId),
      ).toEqual(["48021:soonest", "48021:later", "48021:unbounded"]);
    });
  });

  describe("asOf is the instant the ACTIVE predicate used", () => {
    it("an unlock expiring after asOf is present and its lapse is computable from asOf", async () => {
      const expiresAt = new Date(Date.now() + 4 * DAY_MS);
      await seedUnlock({
        ownerUserId: USER,
        parcelNodeId: "48021:34137",
        expiresAt,
      });

      const res = await asUser(request(getApp()).get(ROUTE), USER);
      const asOf = Date.parse(res.body.asOf);
      const lapses = Date.parse(res.body.unlocks[0].expiresAt);
      expect(lapses).toBeGreaterThan(asOf);
      // The consumer's "lapses in four days" arithmetic uses the same clock
      // the filter used, so the set and the countdown cannot disagree.
      expect(Math.round((lapses - asOf) / DAY_MS)).toBe(4);
    });
  });
});
