/**
 * v2 reasoning-atom grounding — persist reasoning + deeplinks, NOT verbatim code text.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      if (!mocks.db) throw new Error("reasoningAtoms.test: mocks.db not set");
      return mocks.db;
    },
  };
});

import { withTestSchema } from "@workspace/db/testing";
import { reasoningAtoms } from "@workspace/db";
import {
  REASONING_ATOM_PREFIX,
  REASONING_SNIPPET_MAX_CHARS,
  capReasoningSnippet,
  mergeReasoningSources,
  reasoningAtomId,
  supplementCodeSectionsWithReasoningGrounding,
  upsertReasoningAtomFromWebFetch,
} from "../reasoningAtoms/index";
import type { HttpFetcher, WebCodeReviewTarget } from "../webCodeFetch/types";

const FBC_2023_HTML = `
<html><head><title>2023 Florida Building Code — Mechanical</title></head>
<body><h1>Section M601.6 Duct insulation</h1>
<p>Return air ducts shall be insulated and sealed. Balanced return air required per Chapter 4.</p>
<p>Edition 2023 Florida Building Code Mechanical 8th edition.</p></body></html>`;

const NEC_2017_HTML = `
<html><head><title>NFPA 70 NEC 2017</title></head>
<body><h1>Article 220 Branch-Circuit Load Calculations</h1>
<p>Load calculations shall be provided on panel schedules. 2017 Edition.</p></body></html>`;

function mockHttp(body: string, url = "https://codes.iccsafe.org/content/FLMECH2023P1"): HttpFetcher {
  return async () => ({ status: 200, body, finalUrl: url });
}

beforeEach(() => {
  mocks.db = null;
});

describe("capReasoningSnippet", () => {
  it("returns null for empty input", () => {
    expect(capReasoningSnippet("")).toBeNull();
    expect(capReasoningSnippet("   ")).toBeNull();
  });

  it("caps at REASONING_SNIPPET_MAX_CHARS", () => {
    const long = "x".repeat(REASONING_SNIPPET_MAX_CHARS + 200);
    const capped = capReasoningSnippet(long)!;
    expect(capped.length).toBeLessThanOrEqual(REASONING_SNIPPET_MAX_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });
});

describe("mergeReasoningSources", () => {
  it("appends a new URL without duplicating", () => {
    const base = [
      {
        url: "https://codes.iccsafe.org/a",
        sourceName: "icc",
        edition: "FBC 2023",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        verified: true,
      },
    ];
    const merged = mergeReasoningSources(base, {
      url: "https://upcodes.io/b",
      sourceName: "upcodes",
      edition: "FBC 2023",
      retrievedAt: "2026-01-02T00:00:00.000Z",
      verified: true,
    });
    expect(merged).toHaveLength(2);
  });

  it("updates existing URL entry instead of duplicating", () => {
    const base = [
      {
        url: "https://codes.iccsafe.org/a",
        sourceName: "icc",
        edition: "FBC 2023",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        verified: false,
      },
    ];
    const merged = mergeReasoningSources(base, {
      url: "https://codes.iccsafe.org/a",
      sourceName: "icc",
      edition: "FBC 2023",
      retrievedAt: "2026-01-02T00:00:00.000Z",
      verified: true,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.verified).toBe(true);
  });
});

describe("reasoning atom persistence", () => {
  it("persists reasoning atom with capped snippet — NOT full section text", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const fullText = "Return air ducts shall be insulated. ".repeat(80);
      const target: WebCodeReviewTarget = {
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        label: "FBC Mechanical M601.6",
        drivers: ["icc"],
      };
      const atom = await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: "miami_beach_fl",
        target,
        result: {
          text: fullText,
          sourceUrl: "https://codes.iccsafe.org/content/FLMECH2023P1",
          retrievedAt: "2026-06-08T12:00:00.000Z",
          edition: "FBC 2023",
          section: "FBC-M601.6",
          confidence: 0.9,
          verified: true,
          sourceName: "icc",
        },
      });

      expect(atom.id).toBe(reasoningAtomId("fbc-2023", "FBC-M601.6"));
      expect(atom.id.startsWith(REASONING_ATOM_PREFIX)).toBe(true);
      expect(atom.snippet!.length).toBeLessThanOrEqual(REASONING_SNIPPET_MAX_CHARS);
      expect(atom.snippet).not.toBe(fullText);
      expect(atom.reasoning).toContain("FBC-M601.6");

      const rows = await db.select().from(reasoningAtoms);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.snippet!.length).toBeLessThanOrEqual(REASONING_SNIPPET_MAX_CHARS);
    });
  });

  it("multi-link UPSERT merges second source into one atom", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const target: WebCodeReviewTarget = {
        codeRef: "NEC Art. 220",
        edition: "NEC 2017",
        editionSlug: "nec-2017",
        label: "NEC Art. 220",
        drivers: ["nfpa", "upcodes"],
      };
      await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: "miami_beach_fl",
        target,
        result: {
          text: "Load calculations shall be provided.",
          sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
          retrievedAt: "2026-06-08T12:00:00.000Z",
          edition: "NEC 2017",
          section: "NEC Art. 220",
          confidence: 0.85,
          verified: true,
          sourceName: "nfpa",
        },
      });
      const atom = await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: "miami_beach_fl",
        target,
        result: {
          text: "Load calculations shall be provided.",
          sourceUrl: "https://upcodes.io/nec-2017/article-220",
          retrievedAt: "2026-06-08T13:00:00.000Z",
          edition: "NEC 2017",
          section: "NEC Art. 220",
          confidence: 0.8,
          verified: true,
          sourceName: "upcodes",
        },
      });

      const rows = await db.select().from(reasoningAtoms);
      expect(rows).toHaveLength(1);
      expect(atom.sources).toHaveLength(2);
      expect(atom.sources.map((s) => s.sourceName).sort()).toEqual([
        "nfpa",
        "upcodes",
      ]);
    });
  });
});

describe("retrieve-first grounding", () => {
  it("second run retrieves persisted atoms without web fetch", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      let fetchCount = 0;
      const http: HttpFetcher = async (url) => {
        fetchCount++;
        return {
          status: 200,
          body: NEC_2017_HTML,
          finalUrl: url,
        };
      };

      const logs: string[] = [];
      const log = (msg: string) => logs.push(msg);

      const first = await supplementCodeSectionsWithReasoningGrounding({
        jurisdictionKey: "miami_beach_fl",
        existingSections: [],
        http,
        log,
      });
      expect(first.webFilledCount).toBeGreaterThan(0);
      const firstFetches = fetchCount;

      const second = await supplementCodeSectionsWithReasoningGrounding({
        jurisdictionKey: "miami_beach_fl",
        existingSections: [],
        http,
        log,
      });
      expect(second.reasoningRetrievedCount).toBeGreaterThan(0);
      expect(second.webFilledCount).toBe(0);
      expect(fetchCount).toBe(firstFetches);
      expect(logs.some((l) => l.includes("retrieve-first"))).toBe(true);
      expect(
        second.sections.every((s) => s.atomId.startsWith(REASONING_ATOM_PREFIX)),
      ).toBe(true);
    });
  });

  it("skips targets already covered by corpus labels", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const out = await supplementCodeSectionsWithReasoningGrounding({
        jurisdictionKey: "miami_beach_fl",
        existingSections: [
          { atomId: "uuid-1", label: "FBC-M601.6 — duct insulation" },
        ],
        http: mockHttp(FBC_2023_HTML),
      });
      expect(out.sections.find((s) => s.atomId.includes("m601-6"))).toBeUndefined();
    });
  });
});

describe("schema boundary — no full-section verbatim column", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  it("reasoning_atoms migration has snippet only — no full_text/body/section_text", () => {
    const sql = readFileSync(
      join(repoRoot, "lib/db/drizzle/0035_reasoning_atoms.sql"),
      "utf-8",
    );
    expect(sql).toContain("snippet");
    expect(sql).not.toMatch(/\bfull_text\b/i);
    expect(sql).not.toMatch(/\bsection_text\b/i);
    expect(sql).not.toMatch(/\bbody\b.*text/i);
  });

  it("reasoning_atoms drizzle schema has no verbatim catalog field", () => {
    const src = readFileSync(
      join(repoRoot, "lib/db/src/schema/reasoningAtoms.ts"),
      "utf-8",
    );
    expect(src).toContain("capped snippet");
    expect(src).not.toMatch(/\bfullText\b/);
    expect(src).not.toMatch(/\bsectionText\b/);
    expect(src).not.toMatch(/\bfullSection\b/);
  });

  it("orchestrator does not insert reasoning rows into code_atoms", () => {
    const src = readFileSync(
      join(repoRoot, "lib/codes/src/orchestrator.ts"),
      "utf-8",
    );
    expect(src).not.toContain("reasoning_atoms");
    expect(src).not.toContain(REASONING_ATOM_PREFIX);
  });
});
