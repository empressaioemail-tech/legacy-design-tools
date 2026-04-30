/**
 * Tests for the boot-time `code_atom_sources` self-heal.
 *
 * These exist because the prod incident this code addresses was a silent
 * "fresh DB has zero source rows → warmup discovers nothing" failure. The
 * tests therefore lock in the three behaviors that matter:
 *   1. Empty DB → all required rows get inserted (the prod healing case).
 *   2. Already-populated DB → no spurious writes (idempotency).
 *   3. Drifted row → registry wins (so a typo in dev can't outlive a
 *      redeploy).
 *
 * Same fixturing pattern as orchestrator.test.ts: mock @workspace/db.db to
 * point at a per-test isolated PG schema.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!mocks.db) throw new Error("bootstrap.test: mocks.db not set");
      return mocks.db;
    },
  };
});

import { withTestSchema } from "@workspace/db/testing";
import { codeAtomSources } from "@workspace/db";
import { ensureCodeAtomSources, type BootstrapLogger } from "./bootstrap";
import { REQUIRED_CODE_ATOM_SOURCES } from "./sourceRegistry";

const silentLogger: BootstrapLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  mocks.db = null;
});

describe("ensureCodeAtomSources", () => {
  it("inserts every required row when the table is empty (prod fresh-DB case)", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const result = await ensureCodeAtomSources(silentLogger);
      expect(result.required).toBe(REQUIRED_CODE_ATOM_SOURCES.length);
      expect(result.upserted).toBe(REQUIRED_CODE_ATOM_SOURCES.length);
      expect(result.alreadyPresent).toBe(0);
      expect(result.failures).toEqual([]);

      const rows = await db.select().from(codeAtomSources);
      expect(rows).toHaveLength(REQUIRED_CODE_ATOM_SOURCES.length);
      const names = new Set(rows.map((r) => r.sourceName));
      for (const required of REQUIRED_CODE_ATOM_SOURCES) {
        expect(names.has(required.sourceName)).toBe(true);
      }
    });
  });

  it("is idempotent — a second call performs no writes when rows already match", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      await ensureCodeAtomSources(silentLogger);
      const second = await ensureCodeAtomSources(silentLogger);
      expect(second.upserted).toBe(0);
      expect(second.alreadyPresent).toBe(REQUIRED_CODE_ATOM_SOURCES.length);
      expect(second.failures).toEqual([]);
    });
  });

  it("rewrites a row whose label drifted from the registry (registry-wins)", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const target = REQUIRED_CODE_ATOM_SOURCES[0];
      // Pre-populate with a deliberately wrong label so we can detect the
      // re-write. baseUrl/notes intentionally differ too — registry must
      // overwrite all of them.
      await db.insert(codeAtomSources).values({
        sourceName: target.sourceName,
        label: "WRONG_OLD_LABEL",
        sourceType: "html",
        licenseType: "public_record",
        baseUrl: "https://wrong.example.com",
        notes: "stale notes from a previous deploy",
      });

      const result = await ensureCodeAtomSources(silentLogger);
      // The drifted row must be counted as upserted; the other two were
      // missing entirely so they're upserts as well.
      expect(result.upserted).toBe(REQUIRED_CODE_ATOM_SOURCES.length);
      expect(result.failures).toEqual([]);

      const after = await db
        .select()
        .from(codeAtomSources)
        .where(eq(codeAtomSources.sourceName, target.sourceName));
      expect(after).toHaveLength(1);
      expect(after[0].label).toBe(target.label);
      expect(after[0].baseUrl).toBe(target.baseUrl);
      expect(after[0].notes).toBe(target.notes);
    });
  });
});
