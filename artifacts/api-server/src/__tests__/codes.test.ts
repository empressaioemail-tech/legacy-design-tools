/**
 * /api/codes/* — list, warmup, atom-by-id.
 *
 * Mocks @workspace/codes-sources so adapters return controlled TOC + section
 * payloads (no real network). Mocks @workspace/db.db so route DB calls hit
 * the per-file test schema.
 *
 * The orchestrator + queue logic itself is exercised end-to-end by the
 * dedicated lib/codes test files; here we focus on the route layer:
 * shape contracts, status codes, and that warmup actually calls into the
 * orchestrator's queue.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type {
  CodeSource,
  AtomCandidate,
  TocEntry,
  FetchContext,
} from "@workspace/codes-sources";
import { ctx } from "./test-context";

const sourceMocks = vi.hoisted(() => ({
  listTocImpl: null as
    | null
    | ((input: {
        jurisdictionKey: string;
        codeBook: string;
        edition: string;
      }) => Promise<TocEntry[]>),
  fetchSectionImpl: null as
    | null
    | ((url: string, ctx: FetchContext) => Promise<AtomCandidate[]>),
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("codes.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/codes-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes-sources")>(
      "@workspace/codes-sources",
    );
  const adapter: CodeSource = {
    id: "test_source",
    label: "Test",
    sourceType: "html",
    licenseType: "public_record",
    listToc: async (i) => sourceMocks.listTocImpl?.(i) ?? [],
    fetchSection: async (url, c) =>
      sourceMocks.fetchSectionImpl?.(url, c) ?? [],
  };
  return {
    ...actual,
    getSource: () => adapter,
  };
});

const { setupRouteTests } = await import("./setup");
const { codeAtomSources, codeAtoms } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedGrandCountySources(): Promise<void> {
  if (!ctx.schema) throw new Error("schema not ready");
  await ctx.schema.db.insert(codeAtomSources).values([
    {
      sourceName: "grand_county_html",
      label: "Grand County HTML",
      sourceType: "html",
      licenseType: "public_record",
    },
    {
      sourceName: "grand_county_pdf",
      label: "Grand County PDF",
      sourceType: "pdf",
      licenseType: "public_record",
    },
  ]);
}

describe("GET /api/codes/jurisdictions", () => {
  it("returns one entry per registered jurisdiction with zero atoms in a fresh schema", async () => {
    const res = await request(getApp()).get("/api/codes/jurisdictions");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const keys = (res.body as Array<{ key: string }>).map((j) => j.key).sort();
    expect(keys).toEqual(["bastrop_tx", "grand_county_ut"]);
    const grand = (
      res.body as Array<{
        key: string;
        atomCount: number;
        embeddedCount: number;
        books: Array<{ codeBook: string; atomCount: number }>;
      }>
    ).find((j) => j.key === "grand_county_ut")!;
    expect(grand.atomCount).toBe(0);
    expect(grand.embeddedCount).toBe(0);
    expect(grand.books.map((b) => b.codeBook).sort()).toEqual([
      "IRC_R301_2_1",
      "IWUIC",
    ]);
    expect(grand.books.every((b) => b.atomCount === 0)).toBe(true);
  });
});

describe("POST /api/codes/warmup/:key", () => {
  it("404s when the jurisdiction key is not registered", async () => {
    const res = await request(getApp()).post("/api/codes/warmup/nowhere_xx");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Unknown jurisdiction" });
  });

  it("enqueues TOC entries for each book and drains a small synchronous batch", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    sourceMocks.listTocImpl = async ({ codeBook }) => [
      {
        sectionUrl: `https://example.com/${codeBook}/sec-1`,
        sectionRef: `${codeBook}.1`,
        sectionTitle: "First",
      },
      {
        sectionUrl: `https://example.com/${codeBook}/sec-2`,
        sectionRef: `${codeBook}.2`,
        sectionTitle: "Second",
      },
    ];
    sourceMocks.fetchSectionImpl = async (url) => [
      {
        sectionRef: "AT.1",
        sectionTitle: null,
        body: `body for ${url}`,
        sourceUrl: url,
      },
    ];

    const res = await request(getApp()).post(
      "/api/codes/warmup/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body.jurisdictionKey).toBe("grand_county_ut");
    // 2 books × 2 entries each = 4 enqueued.
    expect(res.body.enqueued).toBe(4);
    expect(res.body.skipped).toBe(0);
    // Synchronous drain pulls up to 3 in one pass.
    expect(res.body.drained.picked).toBe(3);
    expect(res.body.drained.completed).toBe(3);
    expect(res.body.drained.failed).toBe(0);
    expect(res.body.drained.atomsWritten).toBe(3);

    // Confirm atoms landed in the DB and embedding is null (no API key in tests).
    const atoms = await ctx.schema.db.select().from(codeAtoms);
    expect(atoms).toHaveLength(3);
    expect(atoms.every((a) => a.embedding === null)).toBe(true);
    expect(atoms.every((a) => a.jurisdictionKey === "grand_county_ut")).toBe(
      true,
    );
  });
});

describe("GET /api/codes/warmup-status/:key", () => {
  it("404s for an unregistered jurisdiction key", async () => {
    const res = await request(getApp()).get(
      "/api/codes/warmup-status/nowhere_xx",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Unknown jurisdiction" });
  });

  it("returns state=idle with all-zero counts when the queue is empty", async () => {
    const res = await request(getApp()).get(
      "/api/codes/warmup-status/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jurisdictionKey: "grand_county_ut",
      state: "idle",
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
  });

  it("returns state=running with correct counts when pending+in_progress rows exist", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    const { codeAtomFetchQueue, codeAtomSources: srcs } = await import(
      "@workspace/db"
    );
    const sources = await ctx.schema.db.select().from(srcs);
    const sourceId = sources[0].id;
    await ctx.schema.db.insert(codeAtomFetchQueue).values([
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/a",
        status: "pending",
      },
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/b",
        status: "in_progress",
      },
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/c",
        status: "completed",
        completedAt: new Date(),
      },
    ]);

    const res = await request(getApp()).get(
      "/api/codes/warmup-status/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "running",
      pending: 1,
      processing: 1,
      completed: 1,
      failed: 0,
      total: 3,
      lastError: null,
    });
    // While running, completedAt is suppressed (it'd be misleading mid-batch).
    expect(res.body.completedAt).toBeNull();
    // startedAt is the earliest createdAt across the rows.
    expect(typeof res.body.startedAt).toBe("string");
  });

  it("surfaces the most recent failed-row lastError text and reports state=failed", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    const { codeAtomFetchQueue, codeAtomSources: srcs } = await import(
      "@workspace/db"
    );
    const sources = await ctx.schema.db.select().from(srcs);
    const sourceId = sources[0].id;
    // Two failed rows with different errors + ages — the endpoint must
    // return the most-recently-created one's error text.
    await ctx.schema.db.insert(codeAtomFetchQueue).values([
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/old-fail",
        status: "failed",
        attempts: 5,
        lastError: "old: connection refused",
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/recent-fail",
        status: "failed",
        attempts: 5,
        lastError: "recent: Municode 429 Too Many Requests",
        createdAt: new Date(),
      },
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/done",
        status: "completed",
        completedAt: new Date(),
      },
    ]);

    const res = await request(getApp()).get(
      "/api/codes/warmup-status/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "failed",
      pending: 0,
      processing: 0,
      completed: 1,
      failed: 2,
      total: 3,
      lastError: "recent: Municode 429 Too Many Requests",
    });
  });

  it("returns state=completed with no lastError when all rows finished cleanly", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    const { codeAtomFetchQueue, codeAtomSources: srcs } = await import(
      "@workspace/db"
    );
    const sources = await ctx.schema.db.select().from(srcs);
    const sourceId = sources[0].id;
    await ctx.schema.db.insert(codeAtomFetchQueue).values([
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/a",
        status: "completed",
        completedAt: new Date("2026-04-30T11:00:00Z"),
      },
      {
        sourceId,
        jurisdictionKey: "grand_county_ut",
        codeBook: "IRC_R301_2_1",
        edition: "2021",
        sectionUrl: "https://example.com/b",
        status: "completed",
        completedAt: new Date("2026-04-30T11:01:00Z"),
      },
    ]);

    const res = await request(getApp()).get(
      "/api/codes/warmup-status/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "completed",
      pending: 0,
      processing: 0,
      completed: 2,
      failed: 0,
      total: 2,
      lastError: null,
    });
    expect(res.body.completedAt).toBe("2026-04-30T11:01:00.000Z");
  });
});

describe("GET /api/codes/jurisdictions/:key/atoms", () => {
  it("404s for an unregistered jurisdiction key", async () => {
    const res = await request(getApp()).get(
      "/api/codes/jurisdictions/nowhere_xx/atoms",
    );
    expect(res.status).toBe(404);
  });

  it("filters atoms by codeBook (and codeBook+edition) when query params are supplied", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    // Two books seed via the warmup pipeline so we exercise the real
    // INSERT path; then verify the filter narrows results server-side.
    sourceMocks.listTocImpl = async ({ codeBook }) => [
      {
        sectionUrl: `https://example.com/${codeBook}/a`,
        sectionRef: `${codeBook}.A`,
        sectionTitle: "A",
      },
      {
        sectionUrl: `https://example.com/${codeBook}/b`,
        sectionRef: `${codeBook}.B`,
        sectionTitle: "B",
      },
    ];
    sourceMocks.fetchSectionImpl = async (url) => [
      {
        sectionRef: "X.1",
        sectionTitle: null,
        body: `body for ${url}`,
        sourceUrl: url,
      },
    ];
    await request(getApp()).post("/api/codes/warmup/grand_county_ut");

    // Unfiltered: all three drained atoms (synchronous warmup pulls 3).
    const all = await request(getApp()).get(
      "/api/codes/jurisdictions/grand_county_ut/atoms",
    );
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(0);
    const allBooks = new Set(
      (all.body as Array<{ codeBook: string }>).map((a) => a.codeBook),
    );
    expect(allBooks.size).toBeGreaterThan(0);

    // Filtered by codeBook only: every row matches IRC_R301_2_1.
    const ircOnly = await request(getApp()).get(
      "/api/codes/jurisdictions/grand_county_ut/atoms?codeBook=IRC_R301_2_1",
    );
    expect(ircOnly.status).toBe(200);
    expect(
      (ircOnly.body as Array<{ codeBook: string }>).every(
        (a) => a.codeBook === "IRC_R301_2_1",
      ),
    ).toBe(true);

    // Filtered by mismatched edition: zero rows.
    const wrongEdition = await request(getApp()).get(
      "/api/codes/jurisdictions/grand_county_ut/atoms?codeBook=IRC_R301_2_1&edition=DOES_NOT_EXIST",
    );
    expect(wrongEdition.status).toBe(200);
    expect(wrongEdition.body).toEqual([]);
  });

  it("warmup POST surfaces per-book discoveryErrors when a source is missing", async () => {
    // Intentionally do NOT seed code_atom_sources — the orchestrator
    // should record source_row_missing for every book and the route
    // must surface that under discoveryErrors so the UI can show it.
    sourceMocks.listTocImpl = async () => [];
    sourceMocks.fetchSectionImpl = async () => [];

    const res = await request(getApp()).post(
      "/api/codes/warmup/grand_county_ut",
    );
    expect(res.status).toBe(200);
    expect(res.body.enqueued).toBe(0);
    expect(Array.isArray(res.body.discoveryErrors)).toBe(true);
    expect(res.body.discoveryErrors.length).toBeGreaterThan(0);
    expect(res.body.discoveryErrors[0]).toHaveProperty("sourceName");
    expect(res.body.discoveryErrors[0]).toHaveProperty("error");
  });

  it("returns the atom list (newest first) with body previews trimmed", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await seedGrandCountySources();
    sourceMocks.listTocImpl = async ({ codeBook }) =>
      codeBook === "IRC_R301_2_1"
        ? [
            {
              sectionUrl: "https://example.com/r301-only",
              sectionRef: "R301.2(1)",
              sectionTitle: "Climatic data",
            },
          ]
        : [];
    sourceMocks.fetchSectionImpl = async () => [
      {
        sectionRef: "R301.2(1)",
        sectionTitle: "Climatic data",
        // Long enough to verify previewBody trimming.
        body: "X ".repeat(500),
        sourceUrl: "https://example.com/r301-only",
      },
    ];

    await request(getApp()).post("/api/codes/warmup/grand_county_ut");

    const list = await request(getApp()).get(
      "/api/codes/jurisdictions/grand_county_ut/atoms",
    );
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].sectionNumber).toBe("R301.2(1)");
    expect(list.body[0].sourceName).toBe("grand_county_html");
    expect(list.body[0].embedded).toBe(false);
    // previewBody caps at ~240 chars + "…"
    expect(list.body[0].bodyPreview.length).toBeLessThanOrEqual(241);
    expect(list.body[0].bodyPreview.endsWith("…")).toBe(true);
  });
});
