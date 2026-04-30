/**
 * Integration tests for the warmup orchestrator's enqueue + atom-write flow.
 *
 * Complements `queue.test.ts` (which exercises the lease/complete/fail
 * mechanics in isolation). This file covers:
 *   - TOC walk → queue rows for each configured book
 *   - Idempotent re-run (onConflictDoNothing on (source_id, section_url))
 *   - Atom write with content_hash recorded, embedding=null when no API key
 *   - Atom dedupe via content_hash unique index
 *   - One section's failure does not poison the rest of the batch
 *
 * Same fixturing pattern as queue.test.ts: mock @workspace/db.db to point at
 * a per-test schema, mock getSource() with a controllable adapter, mock
 * embeddings to avoid network.
 *
 * NOTE: there is intentionally no test for "MunicodeDailyCapExceeded stops
 * the pass cleanly" — the orchestrator does not currently special-case that
 * error (it treats it like any other adapter throw). Documented in
 * TESTS_DEFERRED.md.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  CodeSource,
  AtomCandidate,
  TocEntry,
  FetchContext,
} from "@workspace/codes-sources";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
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
      if (!mocks.db) throw new Error("orchestrator.test: mocks.db not set");
      return mocks.db;
    },
  };
});

vi.mock("@workspace/codes-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes-sources")>(
      "@workspace/codes-sources",
    );
  // One adapter implementation reused for every book — tests vary behavior
  // through `mocks.listTocImpl` / `mocks.fetchSectionImpl`.
  const adapter: CodeSource = {
    id: "test_source",
    label: "Test",
    sourceType: "html",
    licenseType: "public_record",
    listToc: async (input) => {
      if (!mocks.listTocImpl) return [];
      return mocks.listTocImpl(input);
    },
    fetchSection: async (url, ctx) => {
      if (!mocks.fetchSectionImpl) return [];
      return mocks.fetchSectionImpl(url, ctx);
    },
  };
  return {
    ...actual,
    getSource: () => adapter,
  };
});

vi.mock("./embeddings", () => ({
  embedTexts: async (texts: string[]) => ({
    vectors: texts.map(() => null),
    embeddedAny: false,
    skipReason: "no_api_key" as const,
  }),
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: 1536,
}));

import { withTestSchema } from "@workspace/db/testing";
import {
  codeAtomFetchQueue,
  codeAtomSources,
  codeAtoms,
} from "@workspace/db";
import {
  enqueueWarmupForJurisdiction,
  drainQueue,
  type OrchestratorLogger,
} from "./orchestrator";
import { JURISDICTIONS } from "./jurisdictions";
import { REQUIRED_CODE_ATOM_SOURCES } from "./sourceRegistry";

// Derive Grand County's expected source set from the canonical configs so
// adding a new code book to the jurisdiction (or a new row to the source
// registry) doesn't require touching this test file.
const GRAND_COUNTY_BOOKS = JURISDICTIONS.grand_county_ut.books;
const GRAND_COUNTY_SOURCE_NAMES = GRAND_COUNTY_BOOKS.map(
  (b) => b.sourceName,
).sort();
const GRAND_COUNTY_BOOK_COUNT = GRAND_COUNTY_BOOKS.length;

const silentLogger: OrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  mocks.db = null;
  mocks.listTocImpl = null;
  mocks.fetchSectionImpl = null;
});

/**
 * Seed the source rows that grand_county_ut depends on. Every book listed in
 * the jurisdiction's config needs a matching row in code_atom_sources for
 * enqueueWarmupForJurisdiction to find it via loadSourceRow(). Pulling the
 * list from the canonical registry keeps this in lockstep with production
 * config when new books are added.
 */
async function seedGrandCountySources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<void> {
  const rows = GRAND_COUNTY_BOOKS.map((book) => {
    const registryEntry = REQUIRED_CODE_ATOM_SOURCES.find(
      (s) => s.sourceName === book.sourceName,
    );
    if (!registryEntry) {
      // Fail loudly: a book pointing at an unregistered source is a real bug,
      // not just a test setup issue. This guards against silent drift between
      // jurisdictions.ts and sourceRegistry.ts.
      throw new Error(
        `seedGrandCountySources: no REQUIRED_CODE_ATOM_SOURCES entry for ${book.sourceName}`,
      );
    }
    return {
      sourceName: registryEntry.sourceName,
      label: registryEntry.label,
      sourceType: registryEntry.sourceType,
      licenseType: registryEntry.licenseType,
    };
  });
  await db.insert(codeAtomSources).values(rows);
}

describe("enqueueWarmupForJurisdiction", () => {
  it("walks each book's TOC and inserts queue rows with the right shape", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.listTocImpl = async ({ codeBook }) => {
        // Each book yields 2 entries; differentiate by codeBook so the test
        // can assert per-book scoping.
        return [
          {
            sectionUrl: `https://example.com/${codeBook}/sec-1`,
            sectionRef: `${codeBook}.1`,
            sectionTitle: "Section One",
            context: { idx: 1 },
          },
          {
            sectionUrl: `https://example.com/${codeBook}/sec-2`,
            sectionRef: `${codeBook}.2`,
            sectionTitle: "Section Two",
          },
        ];
      };
      await seedGrandCountySources(db);

      const result = await enqueueWarmupForJurisdiction(
        "grand_county_ut",
        silentLogger,
      );
      const ENTRIES_PER_BOOK = 2; // listTocImpl yields 2 entries per book
      expect(result.enqueued).toBe(GRAND_COUNTY_BOOK_COUNT * ENTRIES_PER_BOOK);
      expect(result.skipped).toBe(0);
      expect(result.perBook).toHaveLength(GRAND_COUNTY_BOOK_COUNT);
      expect(result.perBook.map((b) => b.sourceName).sort()).toEqual(
        GRAND_COUNTY_SOURCE_NAMES,
      );

      const rows = await db.select().from(codeAtomFetchQueue);
      expect(rows).toHaveLength(GRAND_COUNTY_BOOK_COUNT * ENTRIES_PER_BOOK);
      expect(rows.every((r) => r.status === "pending")).toBe(true);
      // Spot-check one row's metadata round-trip.
      const ircRow = rows.find((r) =>
        r.sectionUrl.includes("IRC_R301_2_1/sec-1"),
      );
      expect(ircRow).toBeDefined();
      expect(ircRow!.sectionRef).toBe("IRC_R301_2_1.1");
      expect(ircRow!.codeBook).toBe("IRC_R301_2_1");
      expect(ircRow!.edition).toBe("IRC 2021");
      expect(ircRow!.context).toEqual({ idx: 1 });
    });
  });

  it("returns gracefully for an unknown jurisdiction key", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const result = await enqueueWarmupForJurisdiction(
        "nowhere_xx",
        silentLogger,
      );
      expect(result.enqueued).toBe(0);
      expect(result.perBook).toEqual([]);
      const rows = await db.select().from(codeAtomFetchQueue);
      expect(rows).toHaveLength(0);
    });
  });

  it("is idempotent: a second pass on unchanged TOC yields zero enqueued", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.listTocImpl = async ({ codeBook }) => [
        {
          sectionUrl: `https://example.com/${codeBook}/dup`,
          sectionRef: `${codeBook}.dup`,
          sectionTitle: "Dup",
        },
      ];
      await seedGrandCountySources(db);

      const first = await enqueueWarmupForJurisdiction(
        "grand_county_ut",
        silentLogger,
      );
      // listTocImpl yields exactly one entry per book here.
      expect(first.enqueued).toBe(GRAND_COUNTY_BOOK_COUNT);
      expect(first.skipped).toBe(0);

      const second = await enqueueWarmupForJurisdiction(
        "grand_county_ut",
        silentLogger,
      );
      expect(second.enqueued).toBe(0);
      expect(second.skipped).toBe(GRAND_COUNTY_BOOK_COUNT);

      const rows = await db.select().from(codeAtomFetchQueue);
      expect(rows).toHaveLength(GRAND_COUNTY_BOOK_COUNT);
    });
  });
});

describe("drainQueue: atom write side", () => {
  it("inserts atoms with content_hash recorded and embedding=null when API key is absent", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [
        {
          sectionRef: "R301.2(1)",
          sectionTitle: "Climatic and Geographic Design Criteria",
          body: "Ground snow load 50 psf, basic wind speed 110 mph.",
          sourceUrl: "https://example.com/r301-final",
        },
      ];
      // Direct seed of one source + one queue row (skip TOC walk).
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      await db.insert(codeAtomFetchQueue).values({
        sourceId: src.id,
        jurisdictionKey: "j1",
        codeBook: "B1",
        edition: "E1",
        sectionUrl: "https://example.com/r301",
        nextAttemptAt: new Date(),
      });

      const result = await drainQueue(silentLogger, 5);
      expect(result.completed).toBe(1);
      expect(result.atomsWritten).toBe(1);

      const atoms = await db.select().from(codeAtoms);
      expect(atoms).toHaveLength(1);
      expect(atoms[0].body).toBe(
        "Ground snow load 50 psf, basic wind speed 110 mph.",
      );
      expect(atoms[0].sectionNumber).toBe("R301.2(1)");
      expect(atoms[0].embedding).toBeNull();
      expect(atoms[0].embeddingModel).toBeNull();
      expect(atoms[0].embeddedAt).toBeNull();
      // content_hash must be a 64-char hex string.
      expect(atoms[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
      // sanity: pool was used
      expect(pool).toBeDefined();
    });
  });

  it("dedupes identical-content atoms via content_hash unique index", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      // Same body returned both times → same content_hash → second insert
      // hits the unique index and is silently dropped.
      const candidate: AtomCandidate = {
        sectionRef: "R401.3",
        sectionTitle: "Drainage",
        body: "All sites shall be graded to drain water away from the building.",
        sourceUrl: "https://example.com/r401-3",
      };
      mocks.fetchSectionImpl = async () => [candidate];
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      // Two queue rows pointing at different URLs but yielding the same body.
      await db.insert(codeAtomFetchQueue).values([
        {
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/q1",
          nextAttemptAt: new Date(),
        },
        {
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/q2",
          nextAttemptAt: new Date(),
        },
      ]);

      const result = await drainQueue(silentLogger, 5);
      expect(result.completed).toBe(2);
      // Both queue rows completed, but only ONE atom should exist.
      expect(result.atomsWritten).toBe(1);
      const atoms = await db.select().from(codeAtoms);
      expect(atoms).toHaveLength(1);
    });
  });

  it("writes one atom per AtomCandidate when a section yields multiple candidates", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [
        { sectionRef: "T1.A", sectionTitle: null, body: "Alpha", sourceUrl: "https://example.com/t/a" },
        { sectionRef: "T1.B", sectionTitle: null, body: "Bravo", sourceUrl: "https://example.com/t/b" },
        { sectionRef: "T1.C", sectionTitle: null, body: "Charlie", sourceUrl: "https://example.com/t/c" },
      ];
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      await db.insert(codeAtomFetchQueue).values({
        sourceId: src.id,
        jurisdictionKey: "j",
        codeBook: "B",
        edition: "E",
        sectionUrl: "https://example.com/multi",
        nextAttemptAt: new Date(),
      });

      const result = await drainQueue(silentLogger, 5);
      expect(result.completed).toBe(1);
      expect(result.atomsWritten).toBe(3);
      const atoms = await db
        .select({ s: codeAtoms.sectionNumber })
        .from(codeAtoms);
      expect(atoms.map((a) => a.s).sort()).toEqual(["T1.A", "T1.B", "T1.C"]);
    });
  });

  it("one section throwing does not poison sibling rows in the same batch", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async (url) => {
        if (url.includes("explode")) throw new Error("simulated 502");
        return [
          {
            sectionRef: "OK.1",
            sectionTitle: null,
            body: `body for ${url}`,
            sourceUrl: url,
          },
        ];
      };
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const now = new Date();
      await db.insert(codeAtomFetchQueue).values([
        {
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/ok-1",
          nextAttemptAt: now,
        },
        {
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/explode",
          nextAttemptAt: now,
        },
        {
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/ok-2",
          nextAttemptAt: now,
        },
      ]);

      const result = await drainQueue(silentLogger, 10);
      expect(result.picked).toBe(3);
      expect(result.completed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.atomsWritten).toBe(2);

      const failedRow = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.sectionUrl, "https://example.com/explode"));
      expect(failedRow[0].status).toBe("pending"); // 1st failure → still retryable
      expect(failedRow[0].attempts).toBe(1);
      expect(failedRow[0].lastError).toMatch(/simulated 502/);

      const okRows = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.status, "completed"));
      expect(okRows).toHaveLength(2);
    });
  });
});
