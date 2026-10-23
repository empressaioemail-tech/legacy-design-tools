/**
 * T1-A falsifier — the one-time duplicate-account merge (ruling 3), run on a
 * seeded test schema of a LOCAL Postgres. Never run against a remote DSN.
 *
 *  - users sharing a verified email are merged; the PAID account survives
 *    even when it is the newer one;
 *  - saved properties, screens, unlocks, counts, reports and identities move
 *    to the survivor; natural-key duplicates are dropped or combined;
 *  - every touched row is logged with its before-image (reversible);
 *  - unverified emails never merge;
 *  - the dry run writes nothing; a re-run is a no-op;
 *  - the merged-away account's sessions are dead afterwards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("pe-t1a-account-merge: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { applyPeAccountMerge, planPeAccountMerge, countRowsToMove } = await import(
  "../lib/peAccountMerge"
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

const OLD = "2026-01-01T00:00:00Z";
const NEW = "2026-06-01T00:00:00Z";

/**
 * free_old  — oldest account, FREE, email-link identity (verified)
 * paid_new  — newer account, PAID (Solo), Google identity (verified)
 * stranger  — Google identity with the same address, UNVERIFIED (never merges)
 * other     — unrelated user
 */
async function seed(): Promise<void> {
  await q(
    `INSERT INTO users (id, display_name, email, created_at) VALUES
      ('free_old', 'Free', 'dup@example.com', $1),
      ('paid_new', 'Paid', 'dup@example.com', $2),
      ('stranger', 'Stranger', 'dup@example.com', $2),
      ('other', 'Other', 'other@example.com', $1)`,
    [OLD, NEW],
  );
  await q(
    `INSERT INTO pe_user_identities (id, user_id, provider, subject, email, email_verified) VALUES
      ('i1', 'free_old', 'email', 'dup@example.com', 'dup@example.com', true),
      ('i2', 'paid_new', 'google', 'g-paid', 'DUP@example.com', true),
      ('i3', 'stranger', 'google', 'g-stranger', 'dup@example.com', false),
      ('i4', 'other', 'email', 'other@example.com', 'other@example.com', true)`,
  );
  await q(
    `INSERT INTO pe_user_entitlements (owner_user_id, access_tier, subscription_tier, entitlement_source, stripe_customer_id, dev_role) VALUES
      ('free_old', 'free', NULL, NULL, NULL, true),
      ('paid_new', 'paid', 'solo', 'stripe_sub', 'cus_paid', false),
      ('stranger', 'free', NULL, NULL, NULL, false),
      ('other', 'free', NULL, NULL, NULL, false)`,
  );
  await q(
    `INSERT INTO pe_saved_properties (owner_user_id, parcel_node_id, label) VALUES
      ('free_old', '48021:1', 'only on free'),
      ('free_old', '48021:2', 'free copy of shared parcel'),
      ('paid_new', '48021:2', 'paid copy of shared parcel'),
      ('paid_new', '48021:3', 'only on paid'),
      ('other', '48021:9', 'other')`,
  );
  await q(
    `INSERT INTO pe_screens (owner_user_id, name) VALUES ('free_old', 'Free screen'), ('paid_new', 'Paid screen')`,
  );
  await q(
    `INSERT INTO pe_property_unlocks (owner_user_id, parcel_node_id, expires_at, source) VALUES
      ('free_old', '48021:5', '2027-01-01T00:00:00Z', 'stripe'),
      ('paid_new', '48021:5', '2026-12-01T00:00:00Z', 'stripe')`,
  );
  await q(
    `INSERT INTO pe_chat_message_counts (owner_user_id, parcel_node_id, count) VALUES
      ('free_old', '48021:1', 3), ('paid_new', '48021:1', 4)`,
  );
  // T2-WATCH tables.
  await q(
    `INSERT INTO pe_watch_snapshots (owner_user_id, parcel_node_id, facts_hash) VALUES
      ('free_old', '48021:1', 'free-only'),
      ('free_old', '48021:2', 'free-dup'),
      ('paid_new', '48021:2', 'paid-dup')`,
  );
  await q(
    `INSERT INTO pe_watch_changes (owner_user_id, parcel_node_id, kind, title) VALUES
      ('free_old', '48021:1', 'flood_map', 'Flood map change')`,
  );
  await q(
    `INSERT INTO pe_push_subscriptions (owner_user_id, endpoint, keys) VALUES
      ('free_old', 'https://push.example/free-phone', '{}'::jsonb)`,
  );
}

beforeEach(async () => {
  await seed();
});

async function snapshot(): Promise<string> {
  const rows = await q(
    `SELECT 'sp' AS t, owner_user_id AS o, parcel_node_id AS k, label AS v FROM pe_saved_properties
     UNION ALL SELECT 'sc', owner_user_id, name, NULL FROM pe_screens
     UNION ALL SELECT 'un', owner_user_id, parcel_node_id, expires_at::text FROM pe_property_unlocks
     UNION ALL SELECT 'cc', owner_user_id, parcel_node_id, count::text FROM pe_chat_message_counts
     UNION ALL SELECT 'id', user_id, provider, subject FROM pe_user_identities
     UNION ALL SELECT 'en', owner_user_id, access_tier, COALESCE(stripe_customer_id, '') || '/' || dev_role::text FROM pe_user_entitlements
     UNION ALL SELECT 'mg', merged_user_id, survivor_user_id, run_id FROM pe_account_merges
     UNION ALL SELECT 'ml', merged_user_id, table_name, action || ':' || count(*)::text FROM pe_account_merge_rows GROUP BY 2, 3, action
     ORDER BY 1, 2, 3, 4`,
  );
  return JSON.stringify(rows);
}

describe("T1-A duplicate-account merge", () => {
  it("dry run (plan + counts) finds the group, picks the PAID survivor, and writes nothing", async () => {
    const before = await snapshot();
    const client = await ctx.schema!.pool.connect();
    try {
      const groups = await planPeAccountMerge(client);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.survivor.id).toBe("paid_new");
      expect(groups[0]!.merged.map((m) => m.id)).toEqual(["free_old"]);
      const counts = await countRowsToMove(client, ["free_old"]);
      expect(counts.find((c) => c.table === "pe_saved_properties")!.rows).toBe(2);
    } finally {
      client.release();
    }
    expect(await snapshot()).toBe(before);
  });

  it("apply: paid plan wins, rows move, duplicates drop or combine, every row is logged", async () => {
    const client = await ctx.schema!.pool.connect();
    let result: Awaited<ReturnType<typeof applyPeAccountMerge>>;
    try {
      result = await applyPeAccountMerge(client, { runId: "run_test_1" });
    } finally {
      client.release();
    }
    expect(result.mergedUsers).toBe(1);

    const saved = await q<{ owner_user_id: string; parcel_node_id: string; label: string }>(
      "SELECT owner_user_id, parcel_node_id, label FROM pe_saved_properties WHERE owner_user_id <> 'other' ORDER BY parcel_node_id",
    );
    expect(saved).toEqual([
      { owner_user_id: "paid_new", parcel_node_id: "48021:1", label: "only on free" },
      { owner_user_id: "paid_new", parcel_node_id: "48021:2", label: "paid copy of shared parcel" },
      { owner_user_id: "paid_new", parcel_node_id: "48021:3", label: "only on paid" },
    ]);
    const screens = await q<{ owner_user_id: string }>("SELECT DISTINCT owner_user_id FROM pe_screens");
    expect(screens).toEqual([{ owner_user_id: "paid_new" }]);
    expect((await q("SELECT count(*)::int AS n FROM pe_screens"))[0]).toEqual({ n: 2 });

    const unlock = await q<{ owner_user_id: string; expires_at: Date }>(
      "SELECT owner_user_id, expires_at FROM pe_property_unlocks",
    );
    expect(unlock).toHaveLength(1);
    expect(unlock[0]!.owner_user_id).toBe("paid_new");
    expect(unlock[0]!.expires_at.toISOString()).toBe("2027-01-01T00:00:00.000Z");

    expect(await q("SELECT owner_user_id, count FROM pe_chat_message_counts")).toEqual([
      { owner_user_id: "paid_new", count: 7 },
    ]);

    const ids = await q<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM pe_user_identities ORDER BY id",
    );
    expect(ids).toEqual([
      { id: "i1", user_id: "paid_new" },
      { id: "i2", user_id: "paid_new" },
      { id: "i3", user_id: "stranger" },
      { id: "i4", user_id: "other" },
    ]);

    // Survivor keeps its paid plan; the merged user's dev role carries over.
    const ent = await q("SELECT access_tier, subscription_tier, stripe_customer_id, dev_role FROM pe_user_entitlements WHERE owner_user_id = 'paid_new'");
    expect(ent).toEqual([{ access_tier: "paid", subscription_tier: "solo", stripe_customer_id: "cus_paid", dev_role: true }]);

    // Shell kept for reversibility; merge recorded; before-images logged.
    expect((await q("SELECT id FROM users WHERE id = 'free_old'")).length).toBe(1);
    expect(await q("SELECT merged_user_id, survivor_user_id, run_id FROM pe_account_merges")).toEqual([
      { merged_user_id: "free_old", survivor_user_id: "paid_new", run_id: "run_test_1" },
    ]);
    const dropped = await q<{ before: { label: string; owner_user_id: string } }>(
      "SELECT before FROM pe_account_merge_rows WHERE table_name = 'pe_saved_properties' AND action = 'dropped'",
    );
    expect(dropped.map((d) => d.before.label)).toEqual(["free copy of shared parcel"]);
    const moved = await q<{ before: { owner_user_id: string } }>(
      "SELECT before FROM pe_account_merge_rows WHERE table_name = 'pe_saved_properties' AND action = 'moved'",
    );
    expect(moved.map((m) => m.before.owner_user_id)).toEqual(["free_old"]);

    // T2-WATCH: snapshots move (the survivor keeps its own on a shared
    // parcel), changes and push subscriptions move.
    expect(
      await q("SELECT owner_user_id, parcel_node_id, facts_hash FROM pe_watch_snapshots ORDER BY parcel_node_id"),
    ).toEqual([
      { owner_user_id: "paid_new", parcel_node_id: "48021:1", facts_hash: "free-only" },
      { owner_user_id: "paid_new", parcel_node_id: "48021:2", facts_hash: "paid-dup" },
    ]);
    expect(await q("SELECT owner_user_id FROM pe_watch_changes")).toEqual([{ owner_user_id: "paid_new" }]);
    expect(await q("SELECT owner_user_id FROM pe_push_subscriptions")).toEqual([{ owner_user_id: "paid_new" }]);
    expect(
      await q(
        "SELECT table_name, action, count(*)::int AS n FROM pe_account_merge_rows WHERE table_name LIKE 'pe_watch%' OR table_name = 'pe_push_subscriptions' GROUP BY 1, 2 ORDER BY 1, 2",
      ),
    ).toEqual([
      { table_name: "pe_push_subscriptions", action: "moved", n: 1 },
      { table_name: "pe_watch_changes", action: "moved", n: 1 },
      { table_name: "pe_watch_snapshots", action: "dropped", n: 1 },
      { table_name: "pe_watch_snapshots", action: "moved", n: 1 },
    ]);

    // Unverified stranger untouched.
    expect((await q("SELECT count(*)::int AS n FROM pe_account_merges WHERE merged_user_id = 'stranger'"))[0]).toEqual({ n: 0 });
  });

  it("a re-run is a no-op", async () => {
    const c1 = await ctx.schema!.pool.connect();
    try {
      await applyPeAccountMerge(c1, { runId: "run_a" });
    } finally {
      c1.release();
    }
    const after1 = await snapshot();
    const c2 = await ctx.schema!.pool.connect();
    let second: Awaited<ReturnType<typeof applyPeAccountMerge>>;
    try {
      second = await applyPeAccountMerge(c2, { runId: "run_b" });
    } finally {
      c2.release();
    }
    expect(second.groups).toHaveLength(0);
    expect(second.mergedUsers).toBe(0);
    expect(await snapshot()).toBe(after1);
  });

  it("the merged-away account's sessions are dead; the survivor's are not", async () => {
    const loser = await createPeSessionToken("free_old");
    const winner = await createPeSessionToken("paid_new");
    const c = await ctx.schema!.pool.connect();
    try {
      await applyPeAccountMerge(c);
    } finally {
      c.release();
    }
    const l = await request(getApp()).get("/api/auth/session").set("Authorization", `Bearer ${loser.token}`);
    expect(l.body).toEqual({ signedIn: false });
    const w = await request(getApp()).get("/api/auth/session").set("Authorization", `Bearer ${winner.token}`);
    expect(w.body.signedIn).toBe(true);
    expect(w.body.user.providers).toEqual(["email", "google"]);
    expect(w.body.user.plan).toBe("solo");
  });
});
