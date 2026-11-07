/**
 * Lifecycle on Property Explorer signup (P-492: GoHighLevel retired; the
 * outbox writes to `ss_contact` and Resend).
 *
 * `POST /api/auth/session-exchange` enqueues `e1_account_created` exactly when
 * `upsertPeOidcIdentity` reports `isNewUser: true`. The local leg projects it
 * into `ss_contact`; the Resend leg puts the contact in the Smart Site segment
 * with the contract v2 properties and sends `ss.account_created`.
 *
 * Covers (plan section 6 "Contract", run locally against a Resend fake; the
 * production read-back is the integration seat's):
 *   - a `utm_medium=paid` signup lands as Explorer / source ad, and Resend
 *     receives ss_stage=Explorer, ss_source=ad and the ss.account_created event
 *   - a Resend failure never blocks or fails the sign-up response
 *   - a returning user (isNewUser: false) enqueues no second account-created
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-signup-lifecycle: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { peLifecycleOutbox, ssContact } = await vi.importActual<
  typeof import("@workspace/db")
>("@workspace/db");
const { runLifecycleDrainTick } = await import("../lib/peLifecycleDrain");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

function exchangeAuth(req: Test): Test {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  return req.set("Authorization", `Bearer ${secret}`);
}

type Captured = { method: string; url: string; body: Record<string, unknown> | null };

/** A Resend fake: no contact exists until created; every call is recorded. */
function resendFake() {
  const calls: Captured[] = [];
  const contacts = new Set<string>();
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (method === "PATCH" && url.includes("/contacts/")) {
      const email = decodeURIComponent(url.split("/contacts/")[1]!);
      return contacts.has(email)
        ? json(200, { object: "contact", id: "c_1" })
        : json(404, { name: "not_found", message: "Contact not found" });
    }
    if (method === "POST" && url.endsWith("/contacts")) {
      contacts.add(String(body?.["email"]));
      return json(200, { object: "contact", id: "c_1" });
    }
    if (method === "POST" && url.endsWith("/events/send")) {
      return json(200, { object: "event", event: body?.["event"] });
    }
    return json(200, {});
  };
  return { calls, impl };
}

async function settle(userId: string): Promise<void> {
  // The request path tries its own row detached; wait (bounded) for it to
  // let go of the row, then a drain tick finishes anything left.
  for (let i = 0; i < 50; i += 1) {
    const rows = await ctx.schema!.db
      .select({ claimedUntil: peLifecycleOutbox.claimedUntil, localStatus: peLifecycleOutbox.localStatus })
      .from(peLifecycleOutbox)
      .where(eq(peLifecycleOutbox.ownerUserId, userId));
    if (rows.every((r) => r.claimedUntil === null && r.localStatus !== "pending")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await runLifecycleDrainTick({ db: ctx.schema!.db, runScans: false });
}

beforeEach(() => {
  process.env["RESEND_API_KEY"] = "test_resend_key";
  process.env["RESEND_SS_SEGMENT_ID"] = "seg_smart_site";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["RESEND_API_KEY"];
  delete process.env["RESEND_SS_SEGMENT_ID"];
});

describe("session-exchange -> lifecycle on new signup", () => {
  it("a utm_medium=paid signup lands as Explorer/ad in ss_contact and in Resend with ss.account_created", async () => {
    const fake = resendFake();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.impl as typeof fetch);

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-lifecycle-ad",
      email: "lifecycle-ad@example.com",
      displayName: "Ada Signup",
      campaign: "utm_source=facebook&utm_medium=paid&utm_campaign=phase1&utm_content=v2",
    });
    expect(res.status).toBe(201);
    const userId = res.body.userId as string;
    await settle(userId);

    const [contact] = await ctx.schema!.db
      .select()
      .from(ssContact)
      .where(eq(ssContact.userId, userId));
    expect(contact?.stage).toBe("Explorer");
    expect(contact?.source).toBe("ad");
    expect(contact?.plan).toBe("free");
    expect(contact?.billing).toBe("none");
    expect(contact?.firstName).toBe("Ada");
    expect(contact?.utmCampaign).toBe("phase1");
    expect(contact?.resendSegmentAt).toBeTruthy();

    const create = fake.calls.find((c) => c.method === "POST" && c.url.endsWith("/contacts"));
    expect(create?.body).toMatchObject({
      email: "lifecycle-ad@example.com",
      first_name: "Ada",
      segments: [{ id: "seg_smart_site" }],
      properties: { ss_stage: "Explorer", ss_source: "ad", ss_plan: "free" },
    });
    const events = fake.calls
      .filter((c) => c.url.endsWith("/events/send"))
      .map((c) => c.body?.["event"]);
    expect(events).toContain("ss.account_created");
    expect(events.filter((e) => e === "ss.account_created")).toHaveLength(1);
    expect(fake.calls.every((c) => c.url.startsWith("https://api.resend.com/"))).toBe(true);

    const [e1] = await ctx.schema!.db
      .select()
      .from(peLifecycleOutbox)
      .where(
        and(
          eq(peLifecycleOutbox.ownerUserId, userId),
          eq(peLifecycleOutbox.eventType, "e1_account_created"),
        ),
      );
    expect(e1?.localStatus).toBe("sent");
    expect(e1?.resendStatus).toBe("sent");
  });

  it("a Resend network failure does not block or fail the signup response, and the row waits for the drain", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed: network error");
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-lifecycle-network-fail",
      email: "lifecycle-network-fail@example.com",
      displayName: "Network Fail",
    });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.token).toBeTruthy();
    await settle(res.body.userId);
    const [e1] = await ctx.schema!.db
      .select()
      .from(peLifecycleOutbox)
      .where(
        and(
          eq(peLifecycleOutbox.ownerUserId, res.body.userId),
          eq(peLifecycleOutbox.eventType, "e1_account_created"),
        ),
      );
    expect(e1?.localStatus).toBe("sent");
    expect(e1?.resendStatus).toBe("failed");
    expect(e1?.resendError).toMatch(/network error/);
  });

  it("a returning user (isNewUser: false) enqueues no second account-created event", async () => {
    const fake = resendFake();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.impl as typeof fetch);

    const body = {
      provider: "google",
      subject: "google-subject-lifecycle-returning",
      email: "lifecycle-returning@example.com",
      displayName: "Returning",
    };
    const first = await exchangeAuth(request(getApp()).post("/api/auth/session-exchange")).send(body);
    expect(first.status).toBe(201);
    const second = await exchangeAuth(request(getApp()).post("/api/auth/session-exchange")).send(body);
    expect(second.status).toBe(200);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.lifecycleEventId).toBeUndefined();

    const e1 = await ctx.schema!.db
      .select()
      .from(peLifecycleOutbox)
      .where(
        and(
          eq(peLifecycleOutbox.ownerUserId, first.body.userId),
          eq(peLifecycleOutbox.eventType, "e1_account_created"),
        ),
      );
    expect(e1).toHaveLength(1);
  });
});
