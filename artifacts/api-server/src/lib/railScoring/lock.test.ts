/**
 * The divergence test IS the control (DEV_PROCESS 2.4).
 *
 * The scoring run can be triggered two ways, and both write the ledger. The
 * route serialises through `@workspace/db`'s `withClusterSweepLock`; the CLI
 * serialises through `withRailScoreLock` here, because a session-scoped lock
 * on a raw client is what a CLI can actually hold. They contend correctly ONLY
 * while the key expression is identical, and nothing about the type system
 * enforces that. So this reads the other implementation's source and asserts
 * they still agree.
 *
 * CTRL-1 was exactly this shape: one rule, two implementations, one of them
 * updated. It went unnoticed until a proving run tripped over it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  RAIL_SCORE_LOCK_KEY_SQL,
  RAIL_SCORE_LOCK_NAMESPACE,
  withRailScoreLock,
} from "./lock";
import type { RailScoreQueryable } from "./measure";

const here = dirname(fileURLToPath(import.meta.url));
const CLUSTER_LOCK_SOURCE = resolve(
  here,
  "../../../../../lib/db/src/clusterLock.ts",
);

describe("key-expression agreement with @workspace/db", () => {
  const source = readFileSync(CLUSTER_LOCK_SOURCE, "utf8");

  it("can read the other implementation (a missing file must FAIL, not skip)", () => {
    // A test that silently passes when it cannot find what it audits is the
    // fail-open this repo hunts.
    expect(source).toContain("pg_try_advisory_xact_lock");
  });

  it("hashes the same three ingredients, in the same order", () => {
    // Normalised to whitespace-insensitive so formatting differences between a
    // drizzle sql`` template and a plain string do not produce a false alarm,
    // while any change to the KEY still fails.
    const squash = (s: string): string => s.replace(/\s+/g, "");
    const theirs = squash(source);
    expect(theirs).toContain(squash("|| '|' || current_schema()"));
    expect(theirs).toContain(squash("hashtextextended("));
    expect(theirs).toContain(squash(", 0)"));

    const ours = squash(RAIL_SCORE_LOCK_KEY_SQL);
    expect(ours).toBe(squash("hashtextextended($1 || '|' || current_schema(), 0)"));
  });

  it("uses a namespace distinct from the ledger recompute's", () => {
    expect(RAIL_SCORE_LOCK_NAMESPACE).toBe("county_rail_score");
    expect(RAIL_SCORE_LOCK_NAMESPACE).not.toBe("county_ledger_recompute");
  });
});

describe("withRailScoreLock", () => {
  function fakeClient(locked: boolean): {
    client: RailScoreQueryable;
    calls: string[];
  } {
    const calls: string[] = [];
    const client: RailScoreQueryable = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async query(text: string): Promise<any> {
        if (text.includes("pg_try_advisory_lock")) {
          calls.push("acquire");
          return { rows: [{ locked }] };
        }
        if (text.includes("pg_advisory_unlock")) {
          calls.push("release");
          return { rows: [] };
        }
        throw new Error(`unexpected statement: ${text}`);
      },
    };
    return { client, calls };
  }

  it("runs the body and releases when it acquires", async () => {
    const { client, calls } = fakeClient(true);
    const out = await withRailScoreLock(client, RAIL_SCORE_LOCK_NAMESPACE, async () => 42);
    expect(out).toEqual({ acquired: true, result: 42 });
    expect(calls).toEqual(["acquire", "release"]);
  });

  it("does NOT run the body when a peer holds the lock", async () => {
    const { client, calls } = fakeClient(false);
    let ran = false;
    const out = await withRailScoreLock(client, RAIL_SCORE_LOCK_NAMESPACE, async () => {
      ran = true;
      return 1;
    });
    expect(out).toEqual({ acquired: false });
    expect(ran).toBe(false);
    // And it must not release a lock it never took.
    expect(calls).toEqual(["acquire"]);
  });

  it("releases even when the body throws", async () => {
    // A scoring run that dies must not strand the lock for the next operator.
    const { client, calls } = fakeClient(true);
    await expect(
      withRailScoreLock(client, RAIL_SCORE_LOCK_NAMESPACE, async () => {
        throw new Error("measurement blew up");
      }),
    ).rejects.toThrow("measurement blew up");
    expect(calls).toEqual(["acquire", "release"]);
  });

  it("does not mask the body's error with a release failure", async () => {
    const calls: string[] = [];
    const client: RailScoreQueryable = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async query(text: string): Promise<any> {
        if (text.includes("pg_try_advisory_lock")) {
          calls.push("acquire");
          return { rows: [{ locked: true }] };
        }
        calls.push("release-failed");
        throw new Error("connection already gone");
      },
    };
    await expect(
      withRailScoreLock(client, RAIL_SCORE_LOCK_NAMESPACE, async () => {
        throw new Error("the real problem");
      }),
    ).rejects.toThrow("the real problem");
    expect(calls).toEqual(["acquire", "release-failed"]);
  });
});
