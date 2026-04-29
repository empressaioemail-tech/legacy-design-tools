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

describe("GET /api/codes/jurisdictions/:key/atoms", () => {
  it("404s for an unregistered jurisdiction key", async () => {
    const res = await request(getApp()).get(
      "/api/codes/jurisdictions/nowhere_xx/atoms",
    );
    expect(res.status).toBe(404);
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
