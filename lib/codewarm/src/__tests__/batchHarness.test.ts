/**
 * Cold-warm batch harness — calibration-preserving UPSERT, corpus-aware split,
 * no-verbatim boundary, dry-run, budget cap.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  db: null as unknown,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!mocks.db) throw new Error("codewarm.test: mocks.db not set");
      return mocks.db;
    },
  };
});

import { withTestSchema } from "@workspace/db/testing";
import {
  codeAtomSources,
  codeAtoms,
  reasoningAtoms,
} from "@workspace/db";
import {
  REASONING_SNIPPET_MAX_CHARS,
  upsertReasoningAtomFromWebFetch,
  type HttpFetcher,
} from "@workspace/codes";
import { runCodewarmBatch } from "../batchRunner";
import { parseCodewarmManifest } from "../manifest";
import { createCostTracker } from "../costRecord";

const FBC_2023_HTML = `
<html><head><title>2023 Florida Building Code — Mechanical</title></head>
<body><h1>Section M601.6 Duct insulation</h1>
<p>Return air ducts shall be insulated and sealed. Balanced return air required per Chapter 4.</p>
<p>Edition 2023 Florida Building Code Mechanical 8th edition.</p></body></html>`;

const WRONG_EDITION_HTML = `
<html><head><title>2018 Florida Building Code</title></head>
<body><h1>Section M601.6</h1>
<p>Edition 2018 Florida Building Code.</p></body></html>`;

const FIXTURE_MANIFEST = join(
  import.meta.dirname,
  "fixtures/manifest_fixture.json",
);

function mockHttp(body: string, url = "https://codes.iccsafe.org/content/FLMECH2023P1"): HttpFetcher {
  return async () => ({ status: 200, body, finalUrl: url });
}

beforeEach(() => {
  mocks.db = null;
});

describe("parseCodewarmManifest", () => {
  it("flattens codes and groups with grounding flags", () => {
    const entries = parseCodewarmManifest(FIXTURE_MANIFEST);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(entries.find((e) => e.grounding === "NFPA-license-required")).toBeDefined();
    expect(entries.find((e) => e.grounding === "verify-existing-corpus")).toBeDefined();
  });
});

describe("calibration-preserving UPSERT", () => {
  it("re-warm preserves sentinel calibratedConfidence", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const target = {
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        label: "FBC Mechanical M601.6",
        drivers: ["icc", "upcodes"] as ("icc" | "upcodes")[],
      };

      await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: "miami_beach_fl",
        target,
        result: {
          text: "Return air ducts shall be insulated.",
          sourceUrl: "https://codes.iccsafe.org/content/FLMECH2023P1",
          retrievedAt: "2026-06-09T12:00:00.000Z",
          edition: "FBC 2023",
          section: "FBC-M601.6",
          confidence: 0.9,
          verified: true,
          sourceName: "icc",
        },
      });

      await db
        .update(reasoningAtoms)
        .set({ calibratedConfidence: "0.777" })
        .where(eq(reasoningAtoms.codeRef, "FBC-M601.6"));

      await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: "miami_beach_fl",
        target,
        result: {
          text: "Return air ducts shall be insulated and sealed.",
          sourceUrl: "https://upcodes.io/fbc-m601-6",
          retrievedAt: "2026-06-09T13:00:00.000Z",
          edition: "FBC 2023",
          section: "FBC-M601.6",
          confidence: 0.85,
          verified: true,
          sourceName: "upcodes",
        },
      });

      const rows = await db.select().from(reasoningAtoms);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.calibratedConfidence)).toBeCloseTo(0.777, 3);
      expect(rows[0]!.sources).toHaveLength(2);
    });
  });
});

describe("runCodewarmBatch", () => {
  it("warms fixture manifest end-to-end with split log", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const logs: Array<Record<string, unknown>> = [];
      const result = await runCodewarmBatch({
        jurisdictionKey: "miami_beach_fl",
        manifestPath: FIXTURE_MANIFEST,
        http: mockHttp(FBC_2023_HTML),
        log: (_msg, meta) => logs.push(meta ?? {}),
      });

      expect(result.warmedCount).toBeGreaterThan(0);
      expect(result.deeplinkOnlyCount).toBe(1);
      expect(logs.some((m) => m.corpusCoveredCount != null)).toBe(true);

      const rows = await db.select().from(reasoningAtoms);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.snippet == null || row.snippet.length <= REASONING_SNIPPET_MAX_CHARS).toBe(
          true,
        );
        expect(row.reasoning).not.toMatch(/\bfinding\b/i);
      }
    });
  });

  it("dry-run persists nothing", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const result = await runCodewarmBatch({
        jurisdictionKey: "miami_beach_fl",
        manifestPath: FIXTURE_MANIFEST,
        dryRun: true,
        http: mockHttp(FBC_2023_HTML),
      });

      expect(result.dryRun).toBe(true);
      expect(result.warmedCount).toBeGreaterThan(0);
      const rows = await db.select().from(reasoningAtoms);
      expect(rows).toHaveLength(0);
    });
  });

  it("flags wrong-edition as unverified-web-source", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      await runCodewarmBatch({
        jurisdictionKey: "miami_beach_fl",
        manifestPath: FIXTURE_MANIFEST,
        http: async (url) => {
          const body = url.includes("2018") ? WRONG_EDITION_HTML : FBC_2023_HTML;
          return { status: 200, body, finalUrl: url };
        },
      });

      const wrongEdition = await db
        .select()
        .from(reasoningAtoms)
        .where(eq(reasoningAtoms.editionSlug, "fbc-2018"));
      if (wrongEdition[0]) {
        expect(wrongEdition[0].verificationState).toBe("unverified-web-source");
        expect(Number(wrongEdition[0].assertedConfidence)).toBeLessThan(0.5);
      }
    });
  });

  it("corpus-covered references are not web-grounded", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const [source] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "fixture-corpus-m601",
          label: "Fixture corpus",
          sourceType: "html",
          licenseType: "public",
          baseUrl: "https://example.com/corpus",
        })
        .returning();

      await db.insert(codeAtoms).values({
        sourceId: source!.id,
        jurisdictionKey: "miami_beach_fl",
        codeBook: "FBC",
        edition: "2023",
        sectionNumber: "M601.6",
        sectionTitle: "Duct insulation corpus row",
        body: "Corpus body — not persisted to reasoning_atoms.",
        contentHash: "fixture-corpus-m601-6",
        sourceUrl: "https://example.com/corpus/fbc-m601-6",
      });

      const result = await runCodewarmBatch({
        jurisdictionKey: "miami_beach_fl",
        manifestPath: FIXTURE_MANIFEST,
        http: mockHttp(FBC_2023_HTML),
      });

      expect(result.corpusCoveredCount + result.corpusSkippedCount).toBeGreaterThan(0);
      const overlay = await db
        .select()
        .from(reasoningAtoms)
        .where(eq(reasoningAtoms.codeRef, "FBC-M601.6"));
      const corpusOverlay = overlay.find((r) =>
        (r.sources as Array<{ sourceName: string }>).some(
          (s) => s.sourceName === "corpus",
        ),
      );
      expect(corpusOverlay).toBeDefined();
      expect(corpusOverlay!.snippet).toBeNull();
    });
  });

  it("budget cap halts batch", () => {
    const cost = createCostTracker({ budgetCapUsd: 0.001 });
    cost.chargeFetch(0.002);
    expect(cost.haltedByBudget).toBe(true);
  });
});

describe("no-verbatim boundary", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  it("0036 migration renames confidence to asserted_confidence", () => {
    const sql = readFileSync(
      join(repoRoot, "lib/db/drizzle/0036_reasoning_atoms_asserted_confidence.sql"),
      "utf-8",
    );
    expect(sql).toContain("asserted_confidence");
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });

  it("reasoning_atoms schema has no full-section verbatim column", () => {
    const src = readFileSync(
      join(repoRoot, "lib/db/src/schema/reasoningAtoms.ts"),
      "utf-8",
    );
    expect(src).toContain("assertedConfidence");
    expect(src).not.toMatch(/\bfullText\b/);
    expect(src).not.toMatch(/\bsectionText\b/);
  });
});
