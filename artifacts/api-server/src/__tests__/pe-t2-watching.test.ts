/**
 * T2-WATCH falsifiers — the Watching tab API and change detection, on a
 * seeded test schema of a LOCAL Postgres. The one-door reader is replaced at
 * its fetch seam (no retrieval call leaves the process) and `web-push` is
 * mocked (no push service is ever contacted).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: { sendNotification: (...a: unknown[]) => sendNotification(...a) },
}));

vi.mock("@workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t2-watching: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { detectWatchChanges } = await import("../lib/peWatching");
const { setOneDoorFetcherForTests, resetOneDoorModeMemoryForTests } = await import(
  "../lib/oneDoor/oneDoorReaderClient"
);
const { createPeSessionToken } = await import("../lib/peSessions");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await ctx.schema!.pool.query(text, params);
  return r.rows as T[];
}

type Fact = { state: string; value?: unknown; words: string; source?: Record<string, unknown> };
/** What the fake reader answers, per parcel. */
let reader: Record<string, Record<string, Fact>> = {};
/** Entitlement headers the fake reader received, per parcel. */
let headersSeen: Record<string, string | null> = {};
let readerDown = false;

function fact(value: unknown, words: string, adapter = "test"): Fact {
  return { state: "value", value, words, source: { adapter, vintage: null, asOf: null } };
}

function baseFacts(): Record<string, Fact> {
  return {
    situsAddress: fact("100 STURGEON DR", "100 Sturgeon Dr, San Marcos, TX"),
    flood: fact({ zone: "X", panel: "48209C0391F" }, "Zone X · panel 48209C0391F", "fema-nfhl"),
    zoningDistrict: fact("SF-6", "SF-6"),
    maxHeightFt: fact(35, "35 ft"),
    marketValue: { state: "plan-gated", words: "Included in Studio" },
  };
}

beforeEach(() => {
  reader = { "48209:97651": baseFacts(), "48021:1": baseFacts() };
  headersSeen = {};
  readerDown = false;
  resetOneDoorModeMemoryForTests();
  setOneDoorFetcherForTests(async ({ parcelNodeId, entitlementsHeader }) => {
    headersSeen[parcelNodeId] = entitlementsHeader;
    if (readerDown) return { kind: "network" };
    const facts = reader[parcelNodeId];
    if (!facts) return { kind: "ok", status: 404, body: { errorClass: "parcel-not-found", mode: "on" } };
    return {
      kind: "ok",
      status: 200,
      body: { contract: "one-door-v1", mode: "on", parcelNodeId, readAt: "2026-10-22T00:00:00Z", facts },
    };
  });
  sendNotification.mockReset();
  delete process.env["WEB_PUSH_VAPID_PUBLIC_KEY"];
  delete process.env["WEB_PUSH_VAPID_PRIVATE_KEY"];
  delete process.env["WEB_PUSH_SUBJECT"];
});
afterEach(() => {
  setOneDoorFetcherForTests(null);
});

function configurePush(): void {
  process.env["WEB_PUSH_VAPID_PUBLIC_KEY"] = "BPublicKeyForTestsOnly";
  process.env["WEB_PUSH_VAPID_PRIVATE_KEY"] = "privateKeyForTestsOnly";
  process.env["WEB_PUSH_SUBJECT"] = "mailto:test@example.com";
}

async function seedUser(id: string, parcels: Array<[string, string | null]>): Promise<string> {
  await q(`INSERT INTO users (id, display_name, email) VALUES ($1, $1, $2)`, [id, `${id}@example.com`]);
  for (const [parcel, label] of parcels) {
    await q(`INSERT INTO pe_saved_properties (owner_user_id, parcel_node_id, label) VALUES ($1, $2, $3)`, [
      id,
      parcel,
      label,
    ]);
  }
  return (await createPeSessionToken(id)).token;
}

const changeRows = () =>
  q<{ owner_user_id: string; parcel_node_id: string; kind: string; title: string; seen_at: Date | null }>(
    "SELECT owner_user_id, parcel_node_id, kind, title, seen_at FROM pe_watch_changes ORDER BY detected_at, kind",
  );

describe("detectWatchChanges", () => {
  it("first run only snapshots, never alerts", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    const r = await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    expect(r.checked).toBe(1);
    expect(r.firstSnapshots).toBe(1);
    expect(r.changes).toBe(0);
    expect(await changeRows()).toEqual([]);
    const snap = await q<{ facts_hash: string | null; facts: Record<string, { c: string; w?: string }> }>(
      "SELECT facts_hash, facts FROM pe_watch_snapshots",
    );
    expect(snap).toHaveLength(1);
    expect(snap[0]!.facts_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap[0]!.facts["zoningDistrict"]!.w).toBe("SF-6");
    // Plan-gated rails are not stated facts: nothing stored for them.
    expect(snap[0]!.facts["marketValue"]).toBeUndefined();
    // Read as the user: a free user sends no entitlement header.
    expect(headersSeen["48209:97651"]).toBeNull();
  });

  it("an unchanged record gives no change; a re-check inside the window is not even read", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    const within = await detectWatchChanges(undefined, { now: new Date("2026-10-20T06:00:00Z") });
    expect(within.checked).toBe(0);
    const next = await detectWatchChanges(undefined, { now: new Date("2026-10-21T01:00:00Z") });
    expect(next.checked).toBe(1);
    expect(next.changes).toBe(0);
    expect(await changeRows()).toEqual([]);
  });

  it("two overlapping runs (two instances) read each parcel once", async () => {
    await seedUser("u1", [["48209:97651", null], ["48021:1", null]]);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowRead = async () => {
      reads += 1;
      await gate;
      return { zoningDistrict: { c: "v:\"SF-6\"", w: "SF-6" } };
    };
    const now = new Date("2026-10-20T00:00:00Z");
    const a = detectWatchChanges(undefined, { now, read: slowRead, push: false });
    const b = detectWatchChanges(undefined, { now, read: slowRead, push: false });
    // Both runs are in flight together before any read completes.
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.checked + rb.checked).toBe(2);
    expect(reads).toBe(2);
  });

  it("a changed flood zone gives exactly one flood_map change, in the reader's words", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    reader["48209:97651"]!.flood = fact({ zone: "AE", panel: "48209C0391G" }, "Zone AE · panel 48209C0391G", "fema-nfhl");
    const r = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-21T00:00:00Z") });
    expect(r.changes).toBe(1);
    const rows = await changeRows();
    expect(rows).toEqual([
      {
        owner_user_id: "u1",
        parcel_node_id: "48209:97651",
        kind: "flood_map",
        title: "FEMA flood map change: Zone AE · panel 48209C0391G",
        seen_at: null,
      },
    ]);
    // Snapshot moved forward: the same read again is not a second change.
    const again = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-22T00:00:00Z") });
    expect(again.changes).toBe(0);
  });

  it("an outage or a pending/gated state never reads as a change", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    readerDown = true;
    const down = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-21T00:00:00Z") });
    expect(down.unreadable).toBe(1);
    readerDown = false;
    reader["48209:97651"]!.zoningDistrict = { state: "failed", words: "Couldn't load this just now — retry" };
    const failed = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-22T00:00:00Z") });
    expect(failed.changes).toBe(0);
    // Zoning back with the same value: still nothing.
    reader["48209:97651"]!.zoningDistrict = fact("SF-6", "SF-6");
    const back = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-23T00:00:00Z") });
    expect(back.changes).toBe(0);
    expect(await changeRows()).toEqual([]);
    // A gap in one read keeps the old value: a change that lands behind an
    // outage is still compared against SF-6 and caught.
    reader["48209:97651"]!.zoningDistrict = { state: "not-loaded", words: "Not loaded yet" };
    await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-24T00:00:00Z") });
    reader["48209:97651"]!.zoningDistrict = fact("SF-7", "SF-7");
    const changed = await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-25T00:00:00Z") });
    expect(changed.changes).toBe(1);
    expect((await changeRows()).map((r) => [r.kind, r.title])).toEqual([["zoning_case", "Zoning changed: SF-7"]]);
  });

  it("appraisal changes are titled without numbers and read with the user's plan", async () => {
    await seedUser("studio", [["48021:1", null]]);
    await q(
      `INSERT INTO pe_user_entitlements (owner_user_id, access_tier, subscription_tier) VALUES ('studio', 'paid', 'studio')`,
    );
    reader["48021:1"]!.marketValue = fact(412000, "$412,000");
    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    expect(headersSeen["48021:1"]).toContain("marketValue");
    const snap = await q<{ facts: Record<string, { c: string; w?: string }> }>("SELECT facts FROM pe_watch_snapshots");
    expect(JSON.stringify(snap[0]!.facts)).not.toContain("412");
    reader["48021:1"]!.marketValue = fact(455000, "$455,000");
    await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-21T00:00:00Z") });
    const rows = await changeRows();
    expect(rows.map((r) => [r.kind, r.title])).toEqual([["appraisal", "Appraisal updated"]]);
    expect(JSON.stringify(await q("SELECT * FROM pe_watch_changes"))).not.toMatch(/455|412/);
  });

  it("a records-request job reaching complete is a records_request change", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    const [eng] = await q<{ id: string }>(
      `INSERT INTO engagements (name, name_lower) VALUES ('w', 'w') RETURNING id`,
    );
    const [job] = await q<{ id: string }>(
      `INSERT INTO records_request_jobs (engagement_id, user_id, parcel_key, county_fips, status)
       VALUES ($1, 'u1', 'apn:48209:97651', '48209', 'running') RETURNING id`,
      [eng!.id],
    );
    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    await q(`UPDATE records_request_jobs SET status = 'complete' WHERE id = $1`, [job!.id]);
    await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-21T00:00:00Z") });
    expect((await changeRows()).map((r) => [r.kind, r.title])).toEqual([
      ["records_request", "Records request complete"],
    ]);
  });
});

describe("web push", () => {
  async function seedChangeFor(user: string): Promise<void> {
    await detectWatchChanges(user, { now: new Date("2026-10-20T00:00:00Z") });
    reader["48209:97651"]!.flood = fact({ zone: "AE" }, "Zone AE", "fema-nfhl");
    reader["48209:97651"]!.zoningDistrict = fact("SF-7", "SF-7");
  }

  it("sends ONE summary per user; 410 drops the subscription, other failures count", async () => {
    configurePush();
    await seedUser("u1", [["48209:97651", "Sturgeon Dr, San Marcos"]]);
    await q(
      `INSERT INTO pe_push_subscriptions (owner_user_id, endpoint, keys) VALUES
        ('u1', 'https://push.example/ok', '{"p256dh":"k1","auth":"a1"}'),
        ('u1', 'https://push.example/gone', '{"p256dh":"k2","auth":"a2"}'),
        ('u1', 'https://push.example/flaky', '{"p256dh":"k3","auth":"a3"}')`,
    );
    await seedChangeFor("u1");
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (sub.endpoint.endsWith("/flaky")) throw Object.assign(new Error("boom"), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const r = await detectWatchChanges("u1", { force: true, now: new Date("2026-10-21T00:00:00Z") });
    expect(r.changes).toBe(2);
    expect(r.usersNotified).toBe(1);
    expect(r.pushSent).toBe(1);
    expect(r.pushDropped).toBe(1);
    expect(r.pushFailed).toBe(1);
    // One payload per user, sent to each of the user's 3 devices.
    expect(sendNotification).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(sendNotification.mock.calls[0]![1] as string);
    expect(payload.body).toBe("Sturgeon Dr: FEMA flood map change: Zone AE · +1 more");
    expect(payload.data.url).toBe("/?parcel=48209%3A97651&tab=map");
    const subs = await q<{ endpoint: string; failures: number; last_ok_at: Date | null }>(
      "SELECT endpoint, failures, last_ok_at FROM pe_push_subscriptions ORDER BY endpoint",
    );
    expect(subs.map((s) => [s.endpoint, s.failures, s.last_ok_at !== null])).toEqual([
      ["https://push.example/flaky", 1, false],
      ["https://push.example/ok", 0, true],
    ]);
  });

  it("push unconfigured: detection still writes changes and sends nothing", async () => {
    await seedUser("u1", [["48209:97651", null]]);
    await q(
      `INSERT INTO pe_push_subscriptions (owner_user_id, endpoint, keys) VALUES ('u1', 'https://push.example/ok', '{"p256dh":"k","auth":"a"}')`,
    );
    await seedChangeFor("u1");
    const r = await detectWatchChanges("u1", { force: true, now: new Date("2026-10-21T00:00:00Z") });
    expect(r.changes).toBe(2);
    expect(r.pushConfigured).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("/api/watching routes", () => {
  const app = () => request(getApp());

  it("every route requires a signed-in session (401)", async () => {
    configurePush();
    for (const [method, path] of [
      ["get", "/api/watching"],
      ["post", "/api/watching/seen"],
      ["get", "/api/watching/push/key"],
      ["post", "/api/watching/push/subscribe"],
      ["post", "/api/watching/push/unsubscribe"],
    ] as const) {
      const res = await app()[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body).toEqual({ error: "authentication_required" });
    }
    const detect = await app().post("/api/watching/internal/detect").send({});
    expect(detect.status).toBe(401);
  });

  it("push routes answer 503 push_not_configured without the VAPID env", async () => {
    const token = await seedUser("u1", []);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await app().get("/api/watching/push/key").set(auth)).body).toEqual({ error: "push_not_configured" });
    const sub = await app()
      .post("/api/watching/push/subscribe")
      .set(auth)
      .send({ subscription: { endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } } });
    expect(sub.status).toBe(503);
    expect((await app().post("/api/watching/push/unsubscribe").set(auth).send({})).status).toBe(503);
  });

  it("key, subscribe and unsubscribe when configured", async () => {
    configurePush();
    const token = await seedUser("u1", []);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await app().get("/api/watching/push/key").set(auth)).body).toEqual({ publicKey: "BPublicKeyForTestsOnly" });
    const body = { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } } };
    expect((await app().post("/api/watching/push/subscribe").set(auth).send(body)).body).toEqual({ ok: true });
    expect((await app().post("/api/watching/push/subscribe").set(auth).send(body)).status).toBe(200);
    expect(await q("SELECT owner_user_id, endpoint FROM pe_push_subscriptions")).toEqual([
      { owner_user_id: "u1", endpoint: "https://push.example/x" },
    ]);
    const bad = await app()
      .post("/api/watching/push/subscribe")
      .set(auth)
      .send({ subscription: { endpoint: "http://insecure", keys: { p256dh: "k", auth: "a" } } });
    expect(bad.status).toBe(400);
    const un = await app().post("/api/watching/push/unsubscribe").set(auth).send({});
    expect(un.body).toEqual({ ok: true, removed: 1 });
  });

  it("GET lists every saved property with its changes; seen marks only the caller's", async () => {
    const token = await seedUser("u1", [
      ["48209:97651", "Sturgeon Dr, San Marcos"],
      ["48021:1", null],
    ]);
    const other = await seedUser("u2", [["48209:97651", null]]);
    const auth = { Authorization: `Bearer ${token}` };

    const before = await app().get("/api/watching").set(auth);
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(2);
    for (const item of before.body.items) {
      expect(item.lastCheckedAt).toBeNull();
      expect(item.changes).toEqual([]);
    }

    await detectWatchChanges(undefined, { now: new Date("2026-10-20T00:00:00Z") });
    reader["48209:97651"]!.flood = fact({ zone: "AE" }, "Zone AE", "fema-nfhl");
    await detectWatchChanges(undefined, { force: true, now: new Date("2026-10-21T00:00:00Z") });

    const res = await app().get("/api/watching").set(auth);
    const byId = Object.fromEntries(res.body.items.map((i: { parcelNodeId: string }) => [i.parcelNodeId, i]));
    const sturgeon = byId["48209:97651"];
    expect(sturgeon.address).toBe("Sturgeon Dr, San Marcos");
    expect(sturgeon.lastCheckedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(sturgeon.changes).toHaveLength(1);
    expect(sturgeon.changes[0]).toMatchObject({ kind: "flood_map", seen: false });
    expect(typeof sturgeon.changes[0].detectedAt).toBe("string");
    // No saved label: the reader's situs words.
    expect(byId["48021:1"].address).toBe("100 Sturgeon Dr, San Marcos, TX");
    expect(byId["48021:1"].changes).toEqual([]);

    // u2 cannot mark u1's change.
    const otherSeen = await app()
      .post("/api/watching/seen")
      .set({ Authorization: `Bearer ${other}` })
      .send({ changeIds: [sturgeon.changes[0].id] });
    expect(otherSeen.body.updated).toBe(0);

    const seen = await app().post("/api/watching/seen").set(auth).send({ changeIds: [sturgeon.changes[0].id] });
    expect(seen.body).toEqual({ ok: true, updated: 1 });
    const after = await app().get("/api/watching").set(auth);
    const s2 = after.body.items.find((i: { parcelNodeId: string }) => i.parcelNodeId === "48209:97651");
    expect(s2.changes[0].seen).toBe(true);
    expect((await app().post("/api/watching/seen").set(auth).send({ changeIds: ["nope"] })).status).toBe(400);
  });

  it("manual detect is service-token only", async () => {
    const token = await seedUser("u1", [["48209:97651", null]]);
    const asUser = await app().post("/api/watching/internal/detect").set({ Authorization: `Bearer ${token}` }).send({});
    expect(asUser.status).toBe(401);
  });
});
