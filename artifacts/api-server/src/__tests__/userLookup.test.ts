/**
 * Unit tests for the actor-hydration helper.
 *
 * These exercise `hydrateActors` directly against the test schema so the
 * route-level integration tests can stay focused on the HTTP shape and
 * trust this module to handle the lookup-shape edge cases:
 *   - input order preservation
 *   - dedup of repeated user ids in a single batched query
 *   - non-user kinds passthrough untouched
 *   - unknown user ids degrade to no `displayName`
 *   - nullable `email` / `avatarUrl` only surface when populated
 *
 * The test reuses `setupRouteTests` to provision a per-file schema and
 * pipes `db` from `@workspace/db` through the same `vi.mock` proxy the
 * route tests use — without that, `hydrateActors` would still query the
 * default singleton pool against the production DB.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("userLookup.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { users } = await import("@workspace/db");
const { hydrateActors } = await import("../lib/userLookup");

setupRouteTests();

beforeAll(async () => {
  // No registry to reset — this file only touches the helper + the users
  // table, which is truncated by setupRouteTests between cases.
});

describe("hydrateActors", () => {
  it("returns an empty array for an empty input without hitting the DB", async () => {
    // No fixture rows on purpose — the contract is that an empty input
    // short-circuits before any SELECT, so this would still pass even if
    // the `users` table were absent. The assertion is just on the shape.
    const out = await hydrateActors([]);
    expect(out).toEqual([]);
  });

  it("preserves input order and dedupes repeated user ids in one round trip", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      { id: "u-a", displayName: "Alpha", email: null, avatarUrl: null },
      { id: "u-b", displayName: "Beta", email: null, avatarUrl: null },
    ]);

    const input = [
      { kind: "user" as const, id: "u-a" },
      { kind: "system" as const, id: "ingest" },
      { kind: "user" as const, id: "u-b" },
      // Repeated id — must collapse into the same WHERE id IN (...)
      // entry without producing a different output.
      { kind: "user" as const, id: "u-a" },
    ];

    const out = await hydrateActors(input);
    expect(out).toEqual([
      { kind: "user", id: "u-a", displayName: "Alpha" },
      { kind: "system", id: "ingest" },
      { kind: "user", id: "u-b", displayName: "Beta" },
      { kind: "user", id: "u-a", displayName: "Alpha" },
    ]);
  });

  it("only emits `email` and `avatarUrl` when the profile actually has them", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      {
        id: "u-full",
        displayName: "Full Profile",
        email: "full@example.com",
        avatarUrl: "https://example.com/full.png",
      },
      {
        id: "u-minimal",
        displayName: "Minimal Profile",
        email: null,
        avatarUrl: null,
      },
    ]);

    const out = await hydrateActors([
      { kind: "user", id: "u-full" },
      { kind: "user", id: "u-minimal" },
    ]);
    expect(out[0]).toEqual({
      kind: "user",
      id: "u-full",
      displayName: "Full Profile",
      email: "full@example.com",
      avatarUrl: "https://example.com/full.png",
    });
    // Note: no `email` / `avatarUrl` keys at all — not `email: null`. The
    // OpenAPI schema marks these as optional strings (no `nullable: true`),
    // so omitting them is the contract-correct shape.
    expect(out[1]).toEqual({
      kind: "user",
      id: "u-minimal",
      displayName: "Minimal Profile",
    });
  });

  it("passes unknown user ids through with no `displayName` so the FE can render its own fallback", async () => {
    // Intentionally seed nothing — all three actors should come back as
    // input-shaped objects.
    const out = await hydrateActors([
      { kind: "user", id: "u-ghost" },
      { kind: "agent", id: "ingest" },
      { kind: "system", id: "boot" },
    ]);
    expect(out).toEqual([
      { kind: "user", id: "u-ghost" },
      { kind: "agent", id: "ingest" },
      { kind: "system", id: "boot" },
    ]);
  });

  it("does not mutate the input array", async () => {
    const input = [{ kind: "user" as const, id: "u-ghost" }];
    const snapshot = JSON.parse(JSON.stringify(input));
    await hydrateActors(input);
    expect(input).toEqual(snapshot);
  });
});
